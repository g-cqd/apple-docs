import Foundation
import Synchronization

/// Bun's cache stamp (`createStamper`): the corpus database's modification time, re-read at most every 5 s, so
/// tool results cached before a re-sync stop matching once it lands. Monotonic time drives the refresh window.
final class CorpusStamp: Sendable {
    private struct State {
        var value = ""
        var refreshedAt: ContinuousClock.Instant?
    }

    private let databasePath: String
    private let refreshInterval: Duration
    private let state = Mutex(State())
    private let clock = ContinuousClock()

    init(databasePath: String, refreshInterval: Duration = .seconds(5)) {
        self.databasePath = databasePath
        self.refreshInterval = refreshInterval
    }

    func current() -> String {
        let now = clock.now
        return state.withLock { state in
            if let refreshed = state.refreshedAt, now - refreshed < refreshInterval { return state.value }
            state.value = Self.modificationStamp(databasePath)
            state.refreshedAt = now
            return state.value
        }
    }

    /// Milliseconds since process start on the monotonic clock (TTL arithmetic for negative entries).
    static let processStart = ContinuousClock.now

    static func monotonicMilliseconds() -> UInt64 {
        let elapsed = ContinuousClock.now - processStart
        return UInt64(elapsed.components.seconds) * 1_000
            + UInt64(elapsed.components.attoseconds / 1_000_000_000_000_000)
    }

    private static func modificationStamp(_ path: String) -> String {
        let attributes = try? FileManager.default.attributesOfItem(atPath: path)
        let modified = (attributes?[.modificationDate] as? Date)?.timeIntervalSinceReferenceDate ?? 0
        let walModified =
            ((try? FileManager.default.attributesOfItem(atPath: path + "-wal"))?[.modificationDate] as? Date)?
            .timeIntervalSinceReferenceDate ?? 0
        return "1:\(Int64(modified * 1_000)):\(Int64(walModified * 1_000))"
    }
}
