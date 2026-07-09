// `storage gc` — the native port of `storageGc` (src/commands/storage.js):
// drop the requested rendered-output directories (markdown/html, recreated
// empty), delete orphan crawl_state rows (root_slug no longer in roots),
// delete stale activity rows (all of them, or only those older than
// `--older-than` days), and VACUUM unless suppressed. `orphansCleaned` sums
// the two DELETEs' `changes()`, exactly like the JS.

public import ADStorage
import Foundation

/// The gc verb over a writable, migrated corpus.
public enum StorageGC {
    /// The JS `{ droppedDirs, orphansCleaned, vacuumed }` result.
    public struct Result: Sendable, Equatable {
        public let droppedDirs: [String]
        public let orphansCleaned: Int
        public let vacuumed: Bool
    }

    /// Run gc. `drop` is the raw `--drop` list (only the exact entries
    /// "markdown" / "html" act, checked in that order); `olderThan` is the
    /// activity age cutoff in days (nil → delete every activity row);
    /// `vacuum` mirrors `!--no-vacuum`. `log` receives the JS logger.info lines.
    public static func run(
        _ db: SQLiteWriteConnection, dataDir: String, drop: [String] = [], olderThan: Int? = nil,
        vacuum: Bool = true, log: ((String) -> Void)? = nil
    ) throws -> Result {
        var droppedDirs: [String] = []

        if drop.contains("markdown") {
            try dropDirectory(dataDir + "/markdown")
            droppedDirs.append("markdown")
            log?("Dropped markdown directory")
        }
        if drop.contains("html") {
            try dropDirectory(dataDir + "/html")
            droppedDirs.append("html")
            log?("Dropped html directory")
        }

        // Orphan crawl_state entries (root_slug not in roots).
        try db.run("DELETE FROM crawl_state WHERE root_slug NOT IN (SELECT slug FROM roots)")
        var orphansCleaned = try db.changes()

        // Stale activity records — the table's column is `started_at` (v2).
        if let olderThan {
            try db.run(
                "DELETE FROM activity WHERE started_at < datetime('now', '-' || $days || ' days')",
                ["days": .integer(Int64(max(1, olderThan)))])
        } else {
            try db.run("DELETE FROM activity")
        }
        orphansCleaned += try db.changes()

        if vacuum {
            try db.withFileTempStore { () throws(SQLiteWriteError) in
                try db.run("VACUUM")
            }
            log?("VACUUM complete")
        }

        return Result(droppedDirs: droppedDirs, orphansCleaned: orphansCleaned, vacuumed: vacuum)
    }

    /// `rmSync(path, { recursive: true, force: true })` + `ensureDir(path)` —
    /// remove the tree (missing is fine) and recreate it empty.
    private static func dropDirectory(_ path: String) throws {
        try? FileManager.default.removeItem(atPath: path)
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }
}
