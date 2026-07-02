// Public in-process surface. An in-process Swift host holds a connection
// DIRECTLY — no registry indirection. One StorageConnection wraps one
// read-only Connection and is used by exactly one thread at a time (the
// caller enforces this, e.g. a checkout pool — Connection's statement cache
// is unsynchronized and SQLite is opened NOMUTEX).

public final class StorageConnection: @unchecked Sendable {
    let conn: Connection  // internal so the cascade tier methods (SearchRow.swift) can reach it

    /// Opens a read connection for `path`; nil if libsqlite3 / FTS5 / the file
    /// is unavailable. (Kept as the EXACT `init?(path:)` shape — it witnesses
    /// ADServe's `PooledResource`; a defaulted extra parameter would not.)
    public init?(path: String) {
        guard let conn = Connection(path: path, writable: false) else { return nil }
        self.conn = conn
    }

    /// `writable: true` drops the `query_only` guard — used ONLY by the web
    /// build's incremental cache (render index + checkpoint); every read verb
    /// stays on the guarded `init?(path:)`.
    public init?(path: String, writable: Bool) {
        guard let conn = Connection(path: path, writable: writable) else { return nil }
        self.conn = conn
    }

    /// Runs searchPages and returns the result rows framed as a JSON array of
    /// objects (UTF-8 bytes), or nil on a prepare/step error. Hand-framed (no
    /// Foundation). MUST be called from one thread at a time.
    public func searchPagesJSON(_ params: SearchPagesParams) -> [UInt8]? {
        guard let stmt = conn.statement(searchPagesSQL) else { return nil }
        bindSearchPages(stmt, params)
        var out: [UInt8] = []
        out.reserveCapacity(8192)
        guard stmt.runJSON(into: &out) else { return nil }
        return out
    }
}
