// THE read connection (libsqlite3): a single connection to a SQLite corpus
// DB, opened READWRITE so it participates cleanly in the WAL -shm wal-index;
// `PRAGMA query_only = ON` then guarantees it never writes. One connection is
// used by exactly one OS thread, so the statement cache needs no lock.
//
// This is the shipping read path — since the storage pivot (RFC 0007 D-0007-4,
// stage 2c) the ONLY one: the interim ADDB sibling backend and the format
// sniff that chose between them are deleted; `StorageConnection` holds this
// type directly.

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

final class SQLiteConnection: @unchecked Sendable {
    let lib: SQLiteLib
    let db: OpaquePointer
    let hasTrigram: Bool
    let hasBodyFts: Bool
    let hasSections: Bool
    let hasRelationships: Bool
    private var cache: [String: SQLiteStatement] = [:]

    init?(path: String, writable: Bool = false) {
        guard let lib = SQLiteLoader.shared else { return nil }
        self.lib = lib
        var handle: OpaquePointer?
        let flags = SQLite.openReadWrite | SQLite.openNoMutex
        let rc = path.withCString { lib.openV2($0, &handle, flags, nil) }
        guard rc == SQLite.ok, let handle else {
            if let handle { _ = lib.closeV2(handle) }
            return nil
        }
        self.db = handle

        // Reader pragma subset, busy_timeout FIRST: the WAL journal_mode /
        // synchronous / wal_autocheckpoint are file/writer properties already set,
        // so a reader only needs the timeout (to wait out a checkpoint instead of
        // erroring SQLITE_BUSY), query_only (write guard), and the page-cache /
        // mmap knobs. `writable: true` (the S7 web-build incremental cache —
        // document_render_index + sync_checkpoint upserts) skips the guard.
        SQLiteConnection.exec(lib, handle, "PRAGMA busy_timeout = 5000")
        if !writable { SQLiteConnection.exec(lib, handle, "PRAGMA query_only = ON") }
        SQLiteConnection.exec(lib, handle, "PRAGMA cache_size = -64000")
        SQLiteConnection.exec(lib, handle, "PRAGMA temp_store = MEMORY")
        SQLiteConnection.exec(lib, handle, "PRAGMA mmap_size = 10737418240")

        // FTS5 is required (searchPages MATCHes documents_fts + uses bm25). If
        // the dlopen'd libsqlite3 was built without it, fail the open so the
        // fallback path serves every query instead.
        guard
            SQLiteConnection.probeCount(
                lib, handle, "SELECT count(*) FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'") >= 1
        else {
            _ = lib.closeV2(handle)
            return nil
        }

        self.hasTrigram = SQLiteConnection.tableExists(lib, handle, "documents_trigram")
        self.hasBodyFts = SQLiteConnection.tableExists(lib, handle, "documents_body_fts")
        self.hasSections = SQLiteConnection.tableExists(lib, handle, "document_sections")
        self.hasRelationships = SQLiteConnection.tableExists(lib, handle, "document_relationships")
    }

    deinit {
        cache.removeAll()  // finalizes each statement via SQLiteStatement.deinit
        _ = lib.closeV2(db)
    }

    /// Returns the cached statement for `sql`, preparing it on first use.
    func statement(_ sql: String) -> (any StorageStatement)? {
        if let existing = cache[sql] { return existing }
        guard let prepared = SQLiteStatement(lib: lib, db: db, sql: sql) else { return nil }
        cache[sql] = prepared
        return prepared
    }

    /// Prepares a statement WITHOUT caching (finalized when the result is
    /// released). For variable-arity `IN (?,?,…)` enrichment queries whose SQL
    /// text differs per result-count — caching them would churn the per-SQL cache.
    func prepareUncached(_ sql: String) -> (any StorageStatement)? {
        SQLiteStatement(lib: lib, db: db, sql: sql)
    }

    /// Runtime `sqlite_master` table-existence probe (mirrors database.hasTable),
    /// used by read_doc's tier fallback ('full' when a documents table exists).
    func tableExists(_ name: String) -> Bool {
        SQLiteConnection.tableExists(lib, db, name)
    }

    // MARK: - searchPages (framed / JSON)

    /// Runs `searchPagesSQL` and frames the rows into the `[u32 colCount][u32
    /// rowCount][cells…]` payload (the FFI packed-binary path).
    func searchPagesFramed(_ params: SearchPagesParams) -> [UInt8]? {
        guard let stmt = statement(searchPagesSQL) else { return nil }
        bindSearchPages(stmt, params)
        var out: [UInt8] = []
        out.reserveCapacity(4096)
        guard stmt.run(into: &out) else { return nil }
        return out
    }

    /// Runs `searchPagesSQL` and frames the rows into a JSON array of objects
    /// (the in-process server path).
    func searchPagesFramedJSON(_ params: SearchPagesParams) -> [UInt8]? {
        guard let stmt = statement(searchPagesSQL) else { return nil }
        bindSearchPages(stmt, params)
        var out: [UInt8] = []
        out.reserveCapacity(8192)
        guard stmt.runJSON(into: &out) else { return nil }
        return out
    }

    // MARK: - boot helpers

    private static func exec(_ lib: SQLiteLib, _ db: OpaquePointer, _ sql: String) {
        guard let stmt = SQLiteStatement(lib: lib, db: db, sql: sql) else { return }
        _ = lib.step(stmt.stmt)
        // stmt finalized by deinit at scope end
    }

    private static func probeCount(_ lib: SQLiteLib, _ db: OpaquePointer, _ sql: String) -> Int64 {
        guard let stmt = SQLiteStatement(lib: lib, db: db, sql: sql) else { return 0 }
        guard lib.step(stmt.stmt) == SQLite.row else { return 0 }
        return lib.columnInt64(stmt.stmt, 0)
    }

    private static func tableExists(_ lib: SQLiteLib, _ db: OpaquePointer, _ name: String) -> Bool {
        guard
            let stmt = SQLiteStatement(
                lib: lib, db: db,
                sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
        else { return false }
        let bytes = Array(name.utf8)
        bytes.withUnsafeBufferPointer { buf in
            _ = lib.bindText(stmt.stmt, 1, buf.baseAddress, Int32(buf.count), sqliteTransient)
        }
        return lib.step(stmt.stmt) == SQLite.row
    }
}
