// Public in-process surface. An in-process Swift host holds a connection
// DIRECTLY — no registry indirection. One StorageConnection wraps one
// read-only SQLite connection and is used by exactly one thread at a time
// (the caller enforces this, e.g. a checkout pool — the connection's
// statement cache is unsynchronized). Since the storage pivot (RFC 0007
// D-0007-4, stage 2c) the corpus is real SQLite only, so this holds the
// concrete `SQLiteConnection` — the interim dual-backend dispatch (format
// sniffing between libsqlite3 and the ADDB engine) is gone.

public final class StorageConnection: @unchecked Sendable {
    let conn: SQLiteConnection  // internal so the cascade tier methods (SearchRow.swift) can reach it

    /// Opens a read connection for `path`; nil when libsqlite3 / FTS5 / the
    /// file is unavailable. (Kept as the EXACT `init?(path:)` shape — it
    /// witnesses ADServe's `PooledResource`; a defaulted extra parameter
    /// would not.)
    public init?(path: String) {
        guard let conn = SQLiteConnection(path: path, writable: false) else { return nil }
        self.conn = conn
    }

    /// `writable: true` drops the SQLite `query_only` guard — used ONLY by the web
    /// build's incremental cache (render index + checkpoint); every read verb
    /// stays on the guarded `init?(path:)`.
    public init?(path: String, writable: Bool) {
        guard let conn = SQLiteConnection(path: path, writable: writable) else { return nil }
        self.conn = conn
    }

    /// Runs searchPages and returns the result rows framed as a JSON array of
    /// objects (UTF-8 bytes), or nil on a prepare/step error. Hand-framed (no
    /// Foundation). MUST be called from one thread at a time.
    public func searchPagesJSON(_ params: SearchPagesParams) -> [UInt8]? {
        conn.searchPagesFramedJSON(params)
    }
}
