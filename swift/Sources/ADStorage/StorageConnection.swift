// Public in-process surface (RFC 0001 P6). The FFI path (Storage.open /
// search_pages over a u64 handle registry) exists for the bun:ffi boundary;
// an in-process Swift host (the SwiftNIO server) holds a connection DIRECTLY
// — no registry indirection, no FFI. One StorageConnection wraps one
// read-only Connection and is used by exactly one thread at a time (the
// caller enforces this, e.g. a checkout pool — Connection's statement cache
// is unsynchronized and SQLite is opened NOMUTEX).

public final class StorageConnection: @unchecked Sendable {
  let conn: Connection  // internal so the cascade tier methods (SearchRow.swift) can reach it

  /// Opens a read connection for `path`; nil if libsqlite3/FTS5/the file is
  /// unavailable.
  public init?(path: String) {
    guard let conn = Connection(path: path) else { return nil }
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
