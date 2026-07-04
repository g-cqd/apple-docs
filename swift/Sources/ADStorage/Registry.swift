// Maps opaque u64 handles to live Connections. Each reader holds a
// persistent connection; it opens once at bootstrap, stashes the handle,
// and passes it on every read.
//
// Handles are monotonic ids (NOT array indices or pointers) so a closed +
// reopened handle can never alias a different connection across a worker
// recycle. The dylib's globals are process-shared across all worker
// threads, so the id→Connection map is guarded by a Mutex. Each Connection
// itself is touched by only its owning worker thread, so the query runs
// OUTSIDE the lock — the lock covers just the map mutation / lookup.

import Synchronization

public final class ConnectionRegistry: @unchecked Sendable {
    public static let shared = ConnectionRegistry()

    private struct State {
        var next: UInt64 = 1
        var connections: [UInt64: any StorageBackend] = [:]
    }
    private let state = Mutex(State())

    private init() {}

    /// Opens a read connection and returns its handle, or nil if neither backend
    /// (libsqlite3 / FTS5, or the native ADDB engine) can open the file.
    func open(path: String) -> UInt64? {
        guard let conn = openStorageBackend(path: path, writable: false) else { return nil }
        return state.withLock { state in
            let id = state.next
            state.next &+= 1
            state.connections[id] = conn
            return id
        }
    }

    func close(_ id: UInt64) {
        state.withLock { _ = $0.connections.removeValue(forKey: id) }
    }

    /// Looks up the connection (under the lock) and runs `body` with it
    /// OUTSIDE the lock — the connection belongs to the calling thread, so a
    /// long query never blocks other workers' open/close/lookup.
    func withConnection<R>(_ id: UInt64, _ body: (any StorageBackend) -> R) -> R? {
        guard let conn = state.withLock({ $0.connections[id] }) else { return nil }
        return body(conn)
    }
}
