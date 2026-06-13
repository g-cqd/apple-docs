// A single read connection to the corpus DB. Opened READWRITE (matching
// bun:sqlite's reader workers, which open `new Database(path)` without the
// readonly flag) so it participates cleanly in the WAL -shm wal-index that
// the bun:sqlite writer maintains; `PRAGMA query_only = ON` then guarantees
// it never writes. One Connection is used by exactly one OS thread (its
// owning reader worker), so the statement cache needs no lock.

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

final class Connection: @unchecked Sendable {
  let lib: SQLiteLib
  let db: OpaquePointer
  let hasTrigram: Bool
  let hasBodyFts: Bool
  let hasSections: Bool
  let hasRelationships: Bool
  private var cache: [String: PreparedStatement] = [:]

  init?(path: String) {
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

    // Reader pragma subset, busy_timeout FIRST (see pragmas.js): the WAL
    // journal_mode / synchronous / wal_autocheckpoint are file/writer
    // properties the bun:sqlite writer already set, so a reader only needs
    // the timeout (to wait out a checkpoint instead of erroring SQLITE_BUSY),
    // query_only (write guard), and the page-cache / mmap knobs.
    Connection.exec(lib, handle, "PRAGMA busy_timeout = 5000")
    Connection.exec(lib, handle, "PRAGMA query_only = ON")
    Connection.exec(lib, handle, "PRAGMA cache_size = -64000")
    Connection.exec(lib, handle, "PRAGMA temp_store = MEMORY")
    Connection.exec(lib, handle, "PRAGMA mmap_size = 10737418240")

    // FTS5 is required (searchPages MATCHes documents_fts + uses bm25). If
    // the dlopen'd libsqlite3 was built without it, fail the open so the JS
    // bun:sqlite reader serves every query instead.
    guard Connection.probeCount(lib, handle, "SELECT count(*) FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'") >= 1
    else {
      _ = lib.closeV2(handle)
      return nil
    }

    self.hasTrigram = Connection.tableExists(lib, handle, "documents_trigram")
    self.hasBodyFts = Connection.tableExists(lib, handle, "documents_body_fts")
    self.hasSections = Connection.tableExists(lib, handle, "document_sections")
    self.hasRelationships = Connection.tableExists(lib, handle, "document_relationships")
  }

  deinit {
    cache.removeAll()  // finalizes each statement via PreparedStatement.deinit
    _ = lib.closeV2(db)
  }

  /// Returns the cached statement for `sql`, preparing it on first use.
  func statement(_ sql: String) -> PreparedStatement? {
    if let existing = cache[sql] { return existing }
    guard let prepared = PreparedStatement(lib: lib, db: db, sql: sql) else { return nil }
    cache[sql] = prepared
    return prepared
  }

  /// Prepares a statement WITHOUT caching (finalized when the result is
  /// released). For variable-arity `IN (?,?,…)` enrichment queries whose SQL
  /// text differs per result-count — caching them would churn the per-SQL cache.
  func prepareUncached(_ sql: String) -> PreparedStatement? {
    PreparedStatement(lib: lib, db: db, sql: sql)
  }

  // MARK: - boot helpers

  private static func exec(_ lib: SQLiteLib, _ db: OpaquePointer, _ sql: String) {
    guard let stmt = PreparedStatement(lib: lib, db: db, sql: sql) else { return }
    _ = lib.step(stmt.stmt)
    // stmt finalized by deinit at scope end
  }

  private static func probeCount(_ lib: SQLiteLib, _ db: OpaquePointer, _ sql: String) -> Int64 {
    guard let stmt = PreparedStatement(lib: lib, db: db, sql: sql) else { return 0 }
    guard lib.step(stmt.stmt) == SQLite.row else { return 0 }
    return lib.columnInt64(stmt.stmt, 0)
  }

  private static func tableExists(_ lib: SQLiteLib, _ db: OpaquePointer, _ name: String) -> Bool {
    guard let stmt = PreparedStatement(
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
