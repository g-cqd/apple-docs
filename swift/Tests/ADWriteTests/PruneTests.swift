// `prune` gate (Prune + ScopeLoader — the prune.js + lib/scope.js ports):
// out-of-scope roots lose their pages, documents, sections, FTS rows,
// relationships, on-disk files, crawl state, and roots row; kept roots get a
// refreshed page_count; fonts/symbols drop on request; dry-run changes
// nothing; scope validation refuses typo'd frameworks.

import ADStorage
import Foundation
import Testing

@testable import ADWrite

@Suite("Prune — trim the corpus to scope.json")
struct PruneTests {
    private let now = "2026-07-01T00:00:00.000Z"

    private func options(dryRun: Bool = false) -> Prune.Options {
        Prune.Options(dryRun: dryRun, noVacuum: false, now: now, pid: 4242, log: nil)
    }

    /// swift-book (kept) + hig (doomed), one doc each, with a relationship,
    /// body index, and a materialized markdown file for the doomed doc.
    private func seeded() throws -> MaintenanceCorpus {
        let corpus = try MaintenanceCorpus.make("prune")
        let swiftBook = try corpus.addRoot(slug: "swift-book", sourceType: "swift-book", now: now)
        let hig = try corpus.addRoot(slug: "hig", sourceType: "hig", now: now)
        try corpus.addDoc(rootId: swiftBook, key: "swift-book/intro", body: "the swift book", now: now)
        try corpus.addDoc(
            rootId: hig, key: "hig/buttons", body: "button guidance",
            relationships: [NormalizedRelationship(toKey: "hig/controls", relationType: "child")], now: now)
        try CrawlPersist.setCrawlState(corpus.db, path: "hig/buttons", status: "processed", rootSlug: "hig")
        try IndexBody.runFull(corpus.db, now: now)
        _ = try StorageMaterialize.run(corpus.db, dataDir: corpus.dataDir, format: .markdown)
        return corpus
    }

    @Test("removes out-of-scope roots wholesale and keeps the rest")
    func pruneOutOfScope() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        let doomedId = try corpus.docId("hig/buttons")
        #expect(doomedId > 0)

        let scope = CorpusScope(
            sources: ["swift-book"], appleDoccFrameworks: nil, keepFonts: true, keepSymbols: true)
        let summary = try Prune.run(corpus.db, dataDir: corpus.dataDir, scope: scope, options: options())

        #expect(summary.status == "ok")
        #expect(summary.rootsRemoved == 1)
        #expect(summary.rootsKept == 1)
        #expect(summary.pagesRemoved == 1)
        #expect(summary.documentsRemoved == 1)
        #expect(summary.filesRemoved == 1)  // the materialized hig/buttons.md
        #expect(summary.byRoot == [Prune.RootPlan(slug: "hig", sourceType: "hig", pages: 1)])

        // Every hig trace is gone…
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM roots WHERE slug = 'hig'") == 0)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM pages WHERE path = 'hig/buttons'") == 0)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM documents WHERE key = 'hig/buttons'") == 0)
        #expect(
            try corpus.count(
                "SELECT COUNT(*) AS c FROM document_sections WHERE document_id = \(doomedId)") == 0)
        #expect(
            try corpus.count(
                "SELECT COUNT(*) AS c FROM documents_body_fts WHERE rowid = \(doomedId)") == 0)
        #expect(
            try corpus.count(
                "SELECT COUNT(*) AS c FROM document_relationships WHERE from_key = 'hig/buttons'") == 0)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM crawl_state WHERE root_slug = 'hig'") == 0)
        #expect(
            !FileManager.default.fileExists(
                atPath: corpus.dir.appendingPathComponent("markdown/hig/buttons.md").path))

        // …the kept root is intact with a refreshed page_count.
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM documents WHERE key = 'swift-book/intro'") == 1)
        let kept = try corpus.db.get(
            "SELECT page_count AS c FROM roots WHERE slug = 'swift-book'")?
            .int("c")
        #expect(kept == 1)
        // The activity row was cleared on the way out.
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM activity") == 0)
    }

    @Test("dry-run reports the plan and changes nothing")
    func dryRun() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        let scope = CorpusScope(
            sources: ["swift-book"], appleDoccFrameworks: nil, keepFonts: true, keepSymbols: true)
        let summary = try Prune.run(
            corpus.db, dataDir: corpus.dataDir, scope: scope, options: options(dryRun: true))

        #expect(summary.status == "dry-run")
        #expect(summary.rootsRemoved == 1)
        #expect(summary.pagesRemoved == 1)
        #expect(summary.documentsRemoved == 0)  // accounting only — nothing deleted
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM roots") == 2)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM documents") == 2)
    }

    @Test("prune is idempotent — a second run removes nothing")
    func idempotent() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        let scope = CorpusScope(
            sources: ["swift-book"], appleDoccFrameworks: nil, keepFonts: true, keepSymbols: true)
        _ = try Prune.run(corpus.db, dataDir: corpus.dataDir, scope: scope, options: options())
        let second = try Prune.run(corpus.db, dataDir: corpus.dataDir, scope: scope, options: options())
        #expect(second.rootsRemoved == 0)
        #expect(second.pagesRemoved == 0)
        #expect(second.documentsRemoved == 0)
    }

    @Test("a typo'd apple-docc framework slug refuses to prune")
    func unknownFramework() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        let swiftui = try corpus.addRoot(slug: "swiftui", sourceType: "apple-docc", now: now)
        try corpus.addDoc(rootId: swiftui, key: "swiftui/view", body: "prose", now: now)
        let scope = CorpusScope(
            sources: nil, appleDoccFrameworks: ["swiftui", "nope"], keepFonts: true, keepSymbols: true)
        #expect(throws: MaintenanceError.self) {
            try Prune.run(corpus.db, dataDir: corpus.dataDir, scope: scope, options: options())
        }
        // Nothing was deleted by the refusal.
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM roots") == 3)
    }

    @Test("keepFonts/keepSymbols false clears the catalogs and resource trees")
    func dropFontsAndSymbols() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        try corpus.db.run(
            "INSERT INTO apple_font_families (id, display_name, updated_at) VALUES ('sf', 'SF', $now)",
            ["now": .text(now)])
        try corpus.db.run(
            "INSERT INTO sf_symbols (name, scope, updated_at) VALUES ('star', 'public', $now)",
            ["now": .text(now)])
        try corpus.db.run("INSERT INTO sf_symbols_fts (name) VALUES ('star')")
        for sub in ["resources/fonts", "resources/symbols"] {
            try FileManager.default.createDirectory(
                at: corpus.dir.appendingPathComponent(sub), withIntermediateDirectories: true)
        }

        let scope = CorpusScope(
            sources: ["swift-book", "hig"], appleDoccFrameworks: nil, keepFonts: false, keepSymbols: false)
        let summary = try Prune.run(corpus.db, dataDir: corpus.dataDir, scope: scope, options: options())

        #expect(summary.rootsRemoved == 0)
        #expect(summary.fontsDropped)
        #expect(summary.symbolsDropped)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM apple_font_families") == 0)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM sf_symbols") == 0)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM sf_symbols_fts") == 0)
        #expect(
            !FileManager.default.fileExists(
                atPath: corpus.dir.appendingPathComponent("resources/fonts").path))
        #expect(
            !FileManager.default.fileExists(
                atPath: corpus.dir.appendingPathComponent("resources/symbols").path))
    }
}
