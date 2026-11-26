import CSQLite

/// Safe, single-owner SQLite database connection with prepared-statement caching,
/// typed errors, pragma configuration, transactions, and `VACUUM INTO` snapshot support.
///
/// Concurrency safety: `SQLiteConnection` is intentionally not `Sendable`; wrap it inside
/// an actor (such as ``SQLiteConnectionPool`` or a dedicated writer actor) when sharing
/// across tasks.
public final class SQLiteConnection {
    private nonisolated(unsafe) var handle: OpaquePointer?
    private var statementCache: [String: SQLiteStatement] = [:]

    /// Opens a SQLite database at `path` (or `":memory:"`) applying `options`.
    public init(path: String, options: SQLiteOpenOptions = .readWrite) throws(SQLiteError) {
        var db: OpaquePointer?
        let baseFlags: Int32 =
            switch options.mode {
                case .readOnly: SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
                case .readWriteCreate: SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX
            }
        let rc = unsafe sqlite3_open_v2(path, &db, baseFlags, nil)
        guard rc == SQLITE_OK, let opened = db else {
            let error = SQLiteError.fromHandle(db, code: rc)
            if let db {
                _ = unsafe sqlite3_close_v2(db)
            }
            throw error
        }
        self.handle = opened
        try configure(options: options, isInMemory: path == ":memory:")
    }

    deinit {
        close()
    }

    /// Explicitly finalizes cached statements and closes the SQLite handle. Idempotent.
    public func close() {
        statementCache.removeAll()
        if let db = handle {
            _ = unsafe sqlite3_close_v2(db)
            handle = nil
        }
    }

    /// Executes a multi-statement SQL script (typically DDL / migrations).
    public func executeScript(_ sql: String) throws(SQLiteError) {
        let db = try requireOpen()
        var errMsg: UnsafeMutablePointer<CChar>?
        let rc = unsafe sqlite3_exec(db, sql, nil, nil, &errMsg)
        if rc != SQLITE_OK {
            if let errMsg {
                let message = unsafe String(cString: errMsg)
                unsafe sqlite3_free(errMsg)
                throw .sqlite(code: rc, message: message)
            }
            throw SQLiteError.fromHandle(db, code: rc)
        }
    }

    /// Executes a parameterized SQL statement without returning result rows.
    public func execute(_ sql: String, bindings: [SQLiteValue] = []) throws(SQLiteError) {
        let stmt = try cachedStatement(for: sql)
        try stmt.bind(bindings)
        try stmt.run()
    }

    /// Queries all rows returned by a parameterized SQL statement.
    public func query(_ sql: String, bindings: [SQLiteValue] = []) throws(SQLiteError) -> [SQLiteRow] {
        let stmt = try cachedStatement(for: sql)
        try stmt.bind(bindings)
        return try stmt.queryAll()
    }

    /// Queries the first row returned by a parameterized SQL statement, if any.
    public func queryOne(_ sql: String, bindings: [SQLiteValue] = []) throws(SQLiteError) -> SQLiteRow? {
        try query(sql, bindings: bindings).first
    }

    /// Returns the row ID of the most recent successful `INSERT` on this connection.
    public func lastInsertRowID() throws(SQLiteError) -> Int64 {
        let db = try requireOpen()
        return unsafe sqlite3_last_insert_rowid(db)
    }

    /// Returns the number of rows modified by the most recent `INSERT`, `UPDATE`, or `DELETE`.
    public func changes() throws(SQLiteError) -> Int {
        let db = try requireOpen()
        return Int(unsafe sqlite3_changes(db))
    }

    /// Runs `body` inside an `IMMEDIATE` transaction, rolling back automatically on error.
    public func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    /// Reads the `PRAGMA user_version` integer stored in the SQLite header.
    public func userVersion() throws(SQLiteError) -> Int {
        guard let row = try queryOne("PRAGMA user_version") else { return 0 }
        return Int(try row.integer(at: 0))
    }

    /// Sets `PRAGMA user_version` in the SQLite header.
    public func setUserVersion(_ version: Int) throws(SQLiteError) {
        try executeScript("PRAGMA user_version = \(version);")
    }

    /// Writes a self-contained compacted snapshot copy via `VACUUM INTO ?` using file-backed
    /// `temp_store = FILE` to avoid RAM spikes on multi-GB corpora.
    public func vacuumInto(destinationPath: String) throws(SQLiteError) {
        try executeScript("PRAGMA temp_store = FILE;")
        defer { try? executeScript("PRAGMA temp_store = MEMORY;") }
        try execute("VACUUM INTO ?", bindings: [.text(destinationPath)])
    }

    /// Reports the effective `PRAGMA mmap_size` in bytes.
    public func effectiveMmapSize() throws(SQLiteError) -> Int64 {
        guard let row = try queryOne("PRAGMA mmap_size") else { return 0 }
        return try row.integer(at: 0)
    }

    private func configure(options: SQLiteOpenOptions, isInMemory: Bool) throws(SQLiteError) {
        try executeScript("PRAGMA busy_timeout = \(options.busyTimeoutMilliseconds);")
        if options.enableWAL, options.mode == .readWriteCreate, !isInMemory {
            try executeScript("PRAGMA journal_mode = WAL;")
            try executeScript("PRAGMA synchronous = NORMAL;")
            try executeScript("PRAGMA wal_autocheckpoint = 2000;")
        }
        try executeScript("PRAGMA cache_size = -\(options.cacheSizeKiB);")
        try executeScript("PRAGMA temp_store = MEMORY;")
        if !isInMemory {
            try executeScript("PRAGMA mmap_size = \(options.mmapSizeBytes);")
        }
        if options.enableForeignKeys {
            try executeScript("PRAGMA foreign_keys = ON;")
        }
    }

    private func cachedStatement(for sql: String) throws(SQLiteError) -> SQLiteStatement {
        let db = try requireOpen()
        if let existing = statementCache[sql] {
            existing.reset()
            return existing
        }
        let prepared = try SQLiteStatement(connection: db, sql: sql)
        statementCache[sql] = prepared
        return prepared
    }

    private func requireOpen() throws(SQLiteError) -> OpaquePointer {
        guard let db = handle else { throw .closed }
        return db
    }
}
