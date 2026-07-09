// `storage gc` gate (StorageGC — the storageGc port): orphan crawl_state
// cleanup, activity trimming (all vs --older-than), the drop-dirs behavior
// (removed AND recreated empty), and the vacuum switch.

import ADStorage
import Foundation
import Testing

@testable import ADWrite

@Suite("StorageGC — storage gc")
struct StorageGCTests {
    private let now = "2026-07-01T00:00:00.000Z"

    @Test("orphan crawl_state rows and activity rows are removed; VACUUM runs")
    func orphansAndActivity() throws {
        let corpus = try MaintenanceCorpus.make("gc")
        defer { corpus.destroy() }
        let rootId = try corpus.addRoot(slug: "swiftui", now: now)
        try corpus.addDoc(rootId: rootId, key: "swiftui/view", body: "prose", now: now)
        try CrawlPersist.setCrawlState(
            corpus.db, path: "swiftui/view", status: "processed", rootSlug: "swiftui")
        try CrawlPersist.setCrawlState(
            corpus.db, path: "combine/publisher", status: "pending", rootSlug: "combine")
        try corpus.db.run(
            "INSERT OR REPLACE INTO activity (id, action, started_at, pid, roots) "
                + "VALUES (1, 'sync', $now, 42, NULL)",
            ["now": .text(now)])

        let result = try StorageGC.run(corpus.db, dataDir: corpus.dataDir)

        // The combine crawl_state row is orphaned (no combine root) + 1 activity row.
        #expect(result.orphansCleaned == 2)
        #expect(result.vacuumed)
        #expect(result.droppedDirs.isEmpty)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM crawl_state") == 1)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM activity") == 0)
    }

    @Test("--older-than keeps recent activity, deletes only stale rows")
    func olderThan() throws {
        let corpus = try MaintenanceCorpus.make("gc-older")
        defer { corpus.destroy() }
        // A singleton-id table can hold one row; seed a stale row first and gc
        // it, then seed a fresh row and confirm the SAME cutoff keeps it.
        try corpus.db.run(
            "INSERT OR REPLACE INTO activity (id, action, started_at, pid, roots) "
                + "VALUES (1, 'sync', datetime('now', '-40 days'), 42, NULL)")
        let stale = try StorageGC.run(corpus.db, dataDir: corpus.dataDir, olderThan: 30, vacuum: false)
        #expect(stale.orphansCleaned == 1)
        #expect(!stale.vacuumed)

        try corpus.db.run(
            "INSERT OR REPLACE INTO activity (id, action, started_at, pid, roots) "
                + "VALUES (1, 'sync', datetime('now', '-5 days'), 42, NULL)")
        let fresh = try StorageGC.run(corpus.db, dataDir: corpus.dataDir, olderThan: 30, vacuum: false)
        #expect(fresh.orphansCleaned == 0)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM activity") == 1)
    }

    @Test("--drop removes and recreates the markdown/html trees empty")
    func dropDirs() throws {
        let corpus = try MaintenanceCorpus.make("gc-drop")
        defer { corpus.destroy() }
        let markdown = corpus.dir.appendingPathComponent("markdown/swiftui")
        try FileManager.default.createDirectory(at: markdown, withIntermediateDirectories: true)
        try "# stale"
            .write(
                to: markdown.appendingPathComponent("view.md"), atomically: true, encoding: .utf8)

        let result = try StorageGC.run(
            corpus.db, dataDir: corpus.dataDir, drop: ["markdown", "html"], vacuum: false)

        #expect(result.droppedDirs == ["markdown", "html"])
        var isDir: ObjCBool = false
        let mdPath = corpus.dir.appendingPathComponent("markdown").path
        #expect(FileManager.default.fileExists(atPath: mdPath, isDirectory: &isDir) && isDir.boolValue)
        #expect(try FileManager.default.contentsOfDirectory(atPath: mdPath).isEmpty)
        let htmlPath = corpus.dir.appendingPathComponent("html").path
        #expect(FileManager.default.fileExists(atPath: htmlPath, isDirectory: &isDir) && isDir.boolValue)
    }
}
