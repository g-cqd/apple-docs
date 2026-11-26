/// Cooperative async concurrency semaphore bounding heavy asset rendering (`render_sf_symbol`,
/// `render_font_text`) without GCD or blocking threads (Threat Model T-04).
public actor AsyncPermitPool {
    private var available: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    /// Creates a permit pool allowing at most `limit` concurrent operations (`>= 1`).
    public init(limit: Int = 4) {
        self.available = max(1, limit)
    }

    /// Acquires one permit, executes `operation`, and always releases the permit on return or throw.
    public func withPermit<T: Sendable>(
        _ operation: @Sendable () async throws -> T
    ) async rethrows -> T {
        await acquire()
        defer { release() }
        return try await operation()
    }

    private func acquire() async {
        if available > 0 {
            available -= 1
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    private func release() {
        if !waiters.isEmpty {
            let next = waiters.removeFirst()
            next.resume()
        } else {
            available += 1
        }
    }
}
