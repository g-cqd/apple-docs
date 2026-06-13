// A fixed pool of StorageConnections (RFC 0001 P6). Checkout happens INSIDE
// the NIOThreadPool work closure, so at most `count` (= thread count)
// connections are out at once and checkout never blocks. The free-list is
// guarded by a `Synchronization.Mutex` (stdlib, macOS 15+) — a lightweight
// lock, not an actor: an actor would funnel every request through one serial
// executor and cap throughput, whereas this trivial critical section
// (pop/append) does not. One StorageConnection is therefore touched by
// exactly one thread at a time (the C handle's no-lock invariant holds).

import Synchronization
import ADStorage

final class ConnectionPool: Sendable {
  private let free: Mutex<[StorageConnection]>
  let count: Int

  init?(path: String, count: Int) {
    var conns: [StorageConnection] = []
    for _ in 0..<max(1, count) {
      guard let conn = StorageConnection(path: path) else { return nil }
      conns.append(conn)
    }
    free = Mutex(conns)
    self.count = conns.count
  }

  func checkout() -> StorageConnection? {
    free.withLock { $0.popLast() }
  }

  func checkin(_ conn: StorageConnection) {
    free.withLock { $0.append(conn) }
  }
}
