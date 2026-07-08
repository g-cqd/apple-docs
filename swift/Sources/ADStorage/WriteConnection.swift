// The libsqlite3 WRITE connection — the storage-pivot write path (RFC 0007 §11/§12:
// apple-docs drops ADDB as its storage engine and writes REAL SQLite again, the JS
// `bun:sqlite` corpus format). One writable connection per process, used by exactly
// one task at a time (the crawl's single-writer discipline); shares `SQLiteLib` (the
// dlopen'd libsqlite3) and the frozen sqlite3 constants with the read path, but NOT
// `StorageConnection`'s dual-backend shape — a writer is always SQLite, never ADDB.
//
// The open applies the JS writer pragma set (`src/storage/pragmas.js applyPragmas`,
// in its exact order: busy_timeout FIRST, then WAL) so a natively-written corpus has
// the same journal/synchronous/checkpoint properties as a `bun:sqlite`-written one.
// `PRAGMA foreign_keys = ON` is deliberately NOT part of the open — the JS enables it
// only AFTER migrations (`enableForeignKeys`), so ALTER-heavy historical migrations
// never choke on legacy orphaned rows; `migrateSchema` mirrors that sequencing.

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

/// A typed error from the SQLite write path. Carries the failing SQL (prefix) and
/// the `sqlite3_errmsg` text so a crawl/migration failure is diagnosable verbatim.
public enum SQLiteWriteError: Error, CustomStringConvertible, Sendable, Equatable {
    /// libsqlite3 could not be dlopen'd (or lacks FTS5 — the schema needs it).
    case libraryUnavailable
    case cannotOpen(path: String, message: String)
    case prepare(sql: String, message: String)
    case step(sql: String, message: String)
    /// A schema/migration orchestration fault (e.g. a future-version corpus).
    case migration(String)

    public var description: String {
        switch self {
            case .libraryUnavailable:
                return "libsqlite3 (with FTS5) is unavailable — the native write path needs it"
            case .cannotOpen(let path, let message):
                return "cannot open \(path): \(message)"
            case .prepare(let sql, let message):
                return "prepare failed (\(message)) for: \(sql.prefix(120))"
            case .step(let sql, let message):
                return "step failed (\(message)) for: \(sql.prefix(120))"
            case .migration(let message):
                return message
        }
    }
}

/// A cell value for binds and reads on the write connection. The write-path analogue
/// of the read path's internal `BindValue`, plus BLOB (the chunk/vector/raw writers
/// store binary codes).
public enum SQLiteValue: Sendable, Equatable {
    case null
    case integer(Int64)
    case real(Double)
    case text(String)
    case blob([UInt8])
}

/// One result row keyed by column name (`SELECT *` readers key cells dynamically).
public struct SQLiteRow: Sendable {
    /// Result columns in projection order.
    public let columns: [String]
    private let cells: [String: SQLiteValue]

    init(columns: [String], cells: [String: SQLiteValue]) {
        self.columns = columns
        self.cells = cells
    }

    public subscript(name: String) -> SQLiteValue? { cells[name] }

    /// The TEXT cell for `name`, or nil for NULL / non-text.
    public func text(_ name: String) -> String? {
        if case .text(let value)? = cells[name] { return value }
        return nil
    }

    /// The INTEGER cell for `name`, or nil for NULL / non-integer.
    public func int(_ name: String) -> Int64? {
        if case .integer(let value)? = cells[name] { return value }
        return nil
    }

    /// The BLOB cell for `name`, or nil for NULL / non-blob.
    public func blob(_ name: String) -> [UInt8]? {
        if case .blob(let value)? = cells[name] { return value }
        return nil
    }
}

/// A writable (create-if-missing) libsqlite3 connection — the storage layer the
/// native schema migrations + crawl persist write through. NOT pooled and NOT
/// thread-safe: one connection, one task at a time (the statement cache is
/// unsynchronized), exactly the read connections' contract.
public final class SQLiteWriteConnection: @unchecked Sendable {
    let lib: SQLiteLib
    let db: OpaquePointer
    private var cache: [String: SQLiteStatement] = [:]
    private var closed = false

    /// Open (creating if missing) the SQLite database at `path`.
    ///
    /// - Parameters:
    ///   - path: the database file path (parent directory must exist).
    ///   - writerPragmas: apply the JS writer pragma set (`applyPragmas`). `false`
    ///     opens a bare handle (busy_timeout only) — the snapshot copy's mode (the
    ///     JS opens the `VACUUM INTO` copy with no pragmas applied).
    public init(path: String, writerPragmas: Bool = true) throws(SQLiteWriteError) {
        guard let lib = SQLiteLoader.shared else { throw SQLiteWriteError.libraryUnavailable }
        self.lib = lib
        var handle: OpaquePointer?
        let flags = SQLite.openReadWrite | SQLite.openCreate | SQLite.openNoMutex
        let rc = path.withCString { lib.openV2($0, &handle, flags, nil) }
        guard rc == SQLite.ok, let handle else {
            let message = handle.map { lib.errorMessage($0) } ?? "sqlite3_open_v2 rc=\(rc)"
            if let handle { _ = lib.closeV2(handle) }
            throw SQLiteWriteError.cannotOpen(path: path, message: message)
        }
        self.db = handle

        // The schema's FTS5 virtual tables need an FTS5-enabled build (same probe as
        // the read connection); failing here beats "no such module: fts5" mid-migration.
        guard Self.hasFTS5(lib, handle) else {
            _ = lib.closeV2(handle)
            throw SQLiteWriteError.libraryUnavailable
        }

        if writerPragmas {
            // src/storage/pragmas.js applyPragmas, verbatim order — busy_timeout FIRST
            // (journal_mode=WAL is a write that needs the lock).
            try execPragmas([
                "PRAGMA busy_timeout = 5000",
                "PRAGMA journal_mode = WAL",
                "PRAGMA synchronous = NORMAL",
                "PRAGMA cache_size = -64000",
                "PRAGMA temp_store = MEMORY",
                "PRAGMA mmap_size = 10737418240",
                "PRAGMA wal_autocheckpoint = 2000"
            ])
        } else {
            try execPragmas(["PRAGMA busy_timeout = 5000"])
        }
    }

    deinit { close() }

    /// Finalize every cached statement and close the handle. Idempotent; called by
    /// `deinit`, and callable explicitly where close-before-hash ordering matters
    /// (the snapshot copy must be fully checkpointed before its bytes are hashed).
    public func close() {
        guard !closed else { return }
        closed = true
        cache.removeAll()  // finalizes via SQLiteStatement.deinit
        _ = lib.closeV2(db)
    }

    /// `PRAGMA foreign_keys = ON` — call AFTER migrations (the JS `enableForeignKeys`
    /// sequencing: FK enforcement post-schema so historical ALTERs never trip on
    /// legacy orphans). Idempotent.
    public func enableForeignKeys() throws(SQLiteWriteError) {
        try execPragmas(["PRAGMA foreign_keys = ON"])
    }

    // MARK: - statement execution

    /// Run one statement to completion (any result rows are discarded). Named
    /// parameters bind by bare key (`params["slug"]` → the SQL's `$slug`).
    public func run(_ sql: String, _ params: [String: SQLiteValue] = [:]) throws(SQLiteWriteError) {
        let stmt = try statement(sql)
        defer { stmt.reset() }
        bind(stmt, params)
        try stepToDone(stmt, sql: sql)
    }

    /// Run a statement and return its FIRST result row (the `bun:sqlite` `.get()`:
    /// one step, capture, reset) — the `INSERT … RETURNING id` reader. nil when the
    /// statement produces no row.
    @discardableResult
    public func get(_ sql: String, _ params: [String: SQLiteValue] = [:]) throws(SQLiteWriteError) -> SQLiteRow? {
        let stmt = try statement(sql)
        defer { stmt.reset() }
        bind(stmt, params)
        let rc = stmt.step()
        if rc == SQLite.done { return nil }
        guard rc == SQLite.row else {
            throw SQLiteWriteError.step(sql: sql, message: lib.errorMessage(db))
        }
        return Self.decodeRow(stmt)
    }

    /// Run a statement and return EVERY result row (the `bun:sqlite` `.all()`).
    public func all(_ sql: String, _ params: [String: SQLiteValue] = [:]) throws(SQLiteWriteError) -> [SQLiteRow] {
        let stmt = try statement(sql)
        defer { stmt.reset() }
        bind(stmt, params)
        var rows: [SQLiteRow] = []
        while true {
            let rc = stmt.step()
            if rc == SQLite.done { break }
            guard rc == SQLite.row else {
                throw SQLiteWriteError.step(sql: sql, message: lib.errorMessage(db))
            }
            rows.append(Self.decodeRow(stmt))
        }
        return rows
    }

    /// Execute a multi-statement SQL script (the `bun:sqlite` `db.exec` the JS v1
    /// migration replays its DDL block through): prepare/step each statement in
    /// sequence via `sqlite3_prepare_v2`'s tail pointer. No parameters.
    public func exec(_ script: String) throws(SQLiteWriteError) {
        var failure: SQLiteWriteError?
        script.withCString { base in
            var cursor: UnsafePointer<CChar>? = base
            while let current = cursor, current.pointee != 0 {
                var stmt: OpaquePointer?
                var tail: UnsafePointer<CChar>?
                let rc = lib.prepareV2(db, current, -1, &stmt, &tail)
                guard rc == SQLite.ok else {
                    failure = .prepare(
                        sql: String(cString: current), message: lib.errorMessage(db))
                    return
                }
                cursor = tail
                guard let stmt else { continue }  // whitespace / comment between statements
                defer { _ = lib.finalize(stmt) }
                while true {
                    let stepRC = lib.step(stmt)
                    if stepRC == SQLite.done { break }
                    if stepRC == SQLite.row { continue }
                    failure = .step(sql: String(cString: current), message: lib.errorMessage(db))
                    return
                }
            }
        }
        if let failure { throw failure }
    }

    // MARK: - transactions

    /// `BEGIN IMMEDIATE` … `COMMIT`, rolling back on throw — the JS `db.tx()` (the
    /// persist's unit of work). Non-reentrant: never nest.
    public func transaction<T>(_ body: () throws(SQLiteWriteError) -> T) throws(SQLiteWriteError) -> T {
        try run("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try run("COMMIT")
            return result
        } catch {
            try? run("ROLLBACK")
            throw error
        }
    }

    /// Plain `BEGIN` … `COMMIT`, rolling back on throw — the JS migration runner's
    /// deferred transaction (`applyMigrations`). Non-reentrant.
    public func deferredTransaction<T>(_ body: () throws(SQLiteWriteError) -> T) throws(SQLiteWriteError) -> T {
        try run("BEGIN")
        do {
            let result = try body()
            try run("COMMIT")
            return result
        } catch {
            try? run("ROLLBACK")
            throw error
        }
    }

    // MARK: - internals

    /// The cached prepared statement for `sql` (prepared on first use — the crawl
    /// re-runs the same persist statements hundreds of thousands of times).
    private func statement(_ sql: String) throws(SQLiteWriteError) -> SQLiteStatement {
        if let existing = cache[sql] { return existing }
        guard let prepared = SQLiteStatement(lib: lib, db: db, sql: sql) else {
            throw SQLiteWriteError.prepare(sql: sql, message: lib.errorMessage(db))
        }
        cache[sql] = prepared
        return prepared
    }

    /// Bind named parameters: bare keys resolve as `$key` (the JS repos' `$name`
    /// placeholder convention). Keys the SQL does not name are ignored.
    private func bind(_ stmt: SQLiteStatement, _ params: [String: SQLiteValue]) {
        for (key, value) in params {
            let index = "$\(key)".withCString { lib.bindParameterIndex(stmt.stmt, $0) }
            guard index > 0 else { continue }
            switch value {
                case .null:
                    _ = lib.bindNull(stmt.stmt, index)
                case .integer(let v):
                    _ = lib.bindInt64(stmt.stmt, index, v)
                case .real(let v):
                    _ = lib.bindDouble(stmt.stmt, index, v)
                case .text(let s):
                    let bytes = Array(s.utf8)
                    bytes.withUnsafeBufferPointer { buffer in
                        _ = lib.bindText(stmt.stmt, index, buffer.baseAddress, Int32(buffer.count), sqliteTransient)
                    }
                case .blob(let bytes):
                    if bytes.isEmpty {
                        // A zero-length BLOB must bind a non-nil pointer (nil means NULL).
                        withUnsafeTemporaryAllocation(of: UInt8.self, capacity: 1) { scratch in
                            _ = lib.bindBlob(stmt.stmt, index, scratch.baseAddress, 0, sqliteTransient)
                        }
                    } else {
                        bytes.withUnsafeBufferPointer { buffer in
                            _ = lib.bindBlob(stmt.stmt, index, buffer.baseAddress, Int32(buffer.count), sqliteTransient)
                        }
                    }
            }
        }
    }

    private func stepToDone(_ stmt: SQLiteStatement, sql: String) throws(SQLiteWriteError) {
        while true {
            let rc = stmt.step()
            if rc == SQLite.done { return }
            if rc == SQLite.row { continue }  // e.g. RETURNING rows the caller discards
            throw SQLiteWriteError.step(sql: sql, message: lib.errorMessage(db))
        }
    }

    private static func decodeRow(_ stmt: SQLiteStatement) -> SQLiteRow {
        let count = stmt.columnCount()
        var columns: [String] = []
        columns.reserveCapacity(Int(count))
        var cells: [String: SQLiteValue] = [:]
        for col in 0 ..< count {
            let name = stmt.columnName(col) ?? "c\(col)"
            columns.append(name)
            switch stmt.columnType(col) {
                case SQLite.typeInteger: cells[name] = .integer(stmt.int(col) ?? 0)
                case SQLite.typeFloat: cells[name] = .real(stmt.double(col) ?? 0)
                case SQLite.typeText: cells[name] = .text(stmt.text(col) ?? "")
                case SQLite.typeBlob: cells[name] = .blob(stmt.blob(col) ?? [])
                default: cells[name] = .null
            }
        }
        return SQLiteRow(columns: columns, cells: cells)
    }

    private func execPragmas(_ pragmas: [String]) throws(SQLiteWriteError) {
        for pragma in pragmas {
            guard let stmt = SQLiteStatement(lib: lib, db: db, sql: pragma) else {
                throw SQLiteWriteError.prepare(sql: pragma, message: lib.errorMessage(db))
            }
            // Pragmas may return a row (journal_mode does); step to completion.
            while lib.step(stmt.stmt) == SQLite.row { continue }
        }
    }

    private static func hasFTS5(_ lib: SQLiteLib, _ db: OpaquePointer) -> Bool {
        guard
            let stmt = SQLiteStatement(
                lib: lib, db: db,
                sql: "SELECT count(*) FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'")
        else { return false }
        guard lib.step(stmt.stmt) == SQLite.row else { return false }
        return lib.columnInt64(stmt.stmt, 0) >= 1
    }
}
