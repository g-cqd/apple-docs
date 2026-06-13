// Maps opaque u64 handles to live Connections. The FFI boundary is
// stateless per call, but each reader worker needs a persistent connection;
// it calls ad_storage_open once at bootstrap, stashes the handle, and
// passes it on every read.
//
// Handles are monotonic ids (NOT array indices or pointers) so a closed +
// reopened handle can never alias a different connection across a worker
// recycle. The dylib's globals are process-shared across all worker
// threads, so the id→Connection map is guarded by a serial queue (Mutex
// from Synchronization needs macOS 15; the package floor is macOS 13). Each
// Connection itself is touched by only its owning worker thread, so the
// query runs OUTSIDE the queue — the lock covers just the map mutation /
// lookup.

import Dispatch

public final class ConnectionRegistry: @unchecked Sendable {
  public static let shared = ConnectionRegistry()

  private let queue = DispatchQueue(label: "ad.storage.registry")
  private var next: UInt64 = 1
  private var connections: [UInt64: Connection] = [:]

  private init() {}

  /// Opens a read connection and returns its handle, or nil if the dylib /
  /// FTS5 / file is unavailable (→ JS serves).
  func open(path: String) -> UInt64? {
    guard let conn = Connection(path: path) else { return nil }
    return queue.sync {
      let id = next
      next &+= 1
      connections[id] = conn
      return id
    }
  }

  func close(_ id: UInt64) {
    queue.sync { _ = connections.removeValue(forKey: id) }
  }

  /// Looks up the connection (under the lock) and runs `body` with it
  /// OUTSIDE the lock — the connection belongs to the calling thread, so a
  /// long query never blocks other workers' open/close/lookup.
  func withConnection<R>(_ id: UInt64, _ body: (Connection) -> R) -> R? {
    guard let conn = queue.sync(execute: { connections[id] }) else { return nil }
    return body(conn)
  }
}
