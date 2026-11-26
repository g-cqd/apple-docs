/// Bounded concurrent SQLite read connection pool backed by Swift concurrency.
///
/// Opens up to `maxReaders` independent read-only connections against a WAL-mode database,
/// handing each caller an exclusive connection for the duration of a read closure and
/// returning it to the pool even on thrown errors. Avoids GCD completely.
public actor SQLiteReaderPool {
    private let path: String
    private let options: SQLiteOpenOptions
    private let maxReaders: Int
    private var idle: [ConnectionSlot] = []
    private var createdCount = 0
    private var waiters: [CheckedContinuation<ConnectionSlot, any Error>] = []
    private var isClosed = false

    /// Creates a bounded reader pool targeting `path`.
    public init(path: String, maxReaders: Int = 4, options: SQLiteOpenOptions = .readOnly) {
        self.path = path
        self.maxReaders = max(1, maxReaders)
        self.options = options
    }

    /// Borrows a read-only ``SQLiteConnection``, executes `body`, and returns it to the pool.
    public nonisolated func withConnection<T: Sendable>(
        _ body: @Sendable (SQLiteConnection) throws -> T
    ) async throws -> T {
        let slot = try await acquire()
        // Release before returning (not in a detached task): a sequential caller's next request then gets the same
        // connection back, keeping its page cache warm instead of opening another cold connection.
        let result = Result { try body(slot.connection) }
        await release(slot)
        return try result.get()
    }

    /// Closes all idle connections and cancels any pending waiters with ``SQLiteError/closed``.
    public func close() {
        isClosed = true
        for slot in idle {
            slot.connection.close()
        }
        idle.removeAll()
        let pending = waiters
        waiters.removeAll()
        for waiter in pending {
            waiter.resume(throwing: SQLiteError.closed)
        }
    }

    /// Number of connections currently created by the pool.
    public var totalCreatedConnections: Int { createdCount }

    /// Number of connections currently idle and ready for immediate checkout.
    public var idleConnectionCount: Int { idle.count }

    private func acquire() async throws -> ConnectionSlot {
        guard !isClosed else { throw SQLiteError.closed }
        if let slot = idle.popLast() {
            return slot
        }
        if createdCount < maxReaders {
            let connection = try SQLiteConnection(path: path, options: options)
            createdCount += 1
            return ConnectionSlot(connection: connection)
        }
        return try await withCheckedThrowingContinuation { continuation in
            if isClosed {
                continuation.resume(throwing: SQLiteError.closed)
            } else {
                waiters.append(continuation)
            }
        }
    }

    private func release(_ slot: ConnectionSlot) {
        if isClosed {
            slot.connection.close()
            return
        }
        if !waiters.isEmpty {
            let next = waiters.removeFirst()
            next.resume(returning: slot)
            return
        }
        idle.append(slot)
    }
}

/// Exclusive ownership token transferred between the pool actor and one active borrower.
/// A slot is only ever held by either the pool's `idle` array OR a single active caller.
private final class ConnectionSlot: @unchecked Sendable {
    let connection: SQLiteConnection

    init(connection: SQLiteConnection) {
        self.connection = connection
    }
}
