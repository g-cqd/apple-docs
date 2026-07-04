// Public in-process surface. An in-process Swift host holds a connection
// DIRECTLY — no registry indirection. One StorageConnection wraps one
// read-only backend and is used by exactly one thread at a time (the caller
// enforces this, e.g. a checkout pool — the backend's statement cache is
// unsynchronized). The backend is EITHER libsqlite3 (`SQLiteConnection`) or the
// native ADDB engine (`ADDBBackend`), chosen by `openStorageBackend` from the
// corpus file's format — every read method below is backend-agnostic.

public final class StorageConnection: @unchecked Sendable {
    let conn: any StorageBackend  // internal so the cascade tier methods (SearchRow.swift) can reach it

    /// Opens a read connection for `path`; nil if neither backend can open it
    /// (libsqlite3 / FTS5 / the file is unavailable, and it is not an ADDB
    /// corpus). (Kept as the EXACT `init?(path:)` shape — it witnesses ADServe's
    /// `PooledResource`; a defaulted extra parameter would not.)
    public init?(path: String) {
        guard let conn = openStorageBackend(path: path, writable: false) else { return nil }
        self.conn = conn
    }

    /// `writable: true` drops the SQLite `query_only` guard — used ONLY by the web
    /// build's incremental cache (render index + checkpoint); every read verb
    /// stays on the guarded `init?(path:)`. (The ADDB backend ignores the flag —
    /// it always opens writable for the denorm backfill.)
    public init?(path: String, writable: Bool) {
        guard let conn = openStorageBackend(path: path, writable: writable) else { return nil }
        self.conn = conn
    }

    /// Runs searchPages and returns the result rows framed as a JSON array of
    /// objects (UTF-8 bytes), or nil on a prepare/step error. Hand-framed (no
    /// Foundation). MUST be called from one thread at a time.
    public func searchPagesJSON(_ params: SearchPagesParams) -> [UInt8]? {
        conn.searchPagesFramedJSON(params)
    }
}
