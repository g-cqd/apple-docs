// `index rebuild` gate (IndexRebuild — the index-rebuild.js port): the trigram
// rebuild over a cleared/missing table (repopulation + trigger re-creation +
// substring MATCH), and the body rebuild's create-if-missing + full reindex +
// the lite-tier/empty-corpus error RESULTS.

import ADStorage
import Foundation
import Testing

@testable import ADWrite

@Suite("IndexRebuild — index rebuild body/trigram")
struct IndexRebuildTests {
    private let now = "2026-07-01T00:00:00.000Z"

    private func seeded() throws -> MaintenanceCorpus {
        let corpus = try MaintenanceCorpus.make("rebuild")
        let rootId = try corpus.addRoot(slug: "swiftui", now: now)
        try corpus.addDoc(
            rootId: rootId, key: "swiftui/navigationstack", title: "NavigationStack",
            body: "prose about stack navigation", now: now)
        try corpus.addDoc(
            rootId: rootId, key: "swiftui/view", title: "View", body: "prose about views", now: now)
        return corpus
    }

    @Test("trigram rebuild over the migrated (external-content) table")
    func trigramExisting() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        let result = try IndexRebuild.rebuildTrigram(corpus.db)
        #expect(result.status == "ok")
        #expect(result.indexed == 2)
        // Substring match still works after the clear + repopulate.
        let hit = try corpus.db.get(
            "SELECT rowid FROM documents_trigram WHERE documents_trigram MATCH '\"gations\"'")?
            .int("rowid")
        #expect(hit == (try corpus.docId("swiftui/navigationstack")))
        // The migrated triggers already reference documents_trigram — untouched.
        let trigger = try corpus.db.get(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='documents_ai'")?
            .text("sql")
        #expect(trigger?.contains("documents_trigram") == true)
    }

    @Test("trigram rebuild recreates a MISSING table and the triggers")
    func trigramMissing() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        // Simulate a lower-tier snapshot: no trigram table, triggers without it.
        try corpus.db.run("DROP TRIGGER IF EXISTS documents_ai")
        try corpus.db.run("DROP TRIGGER IF EXISTS documents_ad")
        try corpus.db.run("DROP TRIGGER IF EXISTS documents_au")
        try corpus.db.run("DROP TABLE documents_trigram")
        try corpus.db.run(
            """
            CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
                INSERT INTO documents_fts(rowid, title, abstract, declaration, headings, key)
                VALUES (new.id, new.title, new.abstract_text, new.declaration_text, new.headings, new.key);
              END
            """)

        let result = try IndexRebuild.rebuildTrigram(corpus.db)

        #expect(result.indexed == 2)
        let ddl = try corpus.db.get(
            "SELECT sql FROM sqlite_master WHERE name = 'documents_trigram'")?
            .text("sql")
        // The rebuild's own (plain, index-rebuild.js) shape — not external content.
        #expect(ddl?.contains("trigram case_sensitive 0") == true)
        #expect(ddl?.contains("content=") != true)
        for trigger in ["documents_ai", "documents_ad", "documents_au"] {
            let sql = try corpus.db.get(
                "SELECT sql FROM sqlite_master WHERE type='trigger' AND name = $n",
                ["n": .text(trigger)])?
                .text("sql")
            #expect(sql?.contains("documents_trigram") == true, "\(trigger) should maintain trigram")
        }
        let hit = try corpus.db.get(
            "SELECT rowid FROM documents_trigram WHERE documents_trigram MATCH '\"avigation\"'")?
            .int("rowid")
        #expect(hit == (try corpus.docId("swiftui/navigationstack")))
    }

    @Test("body rebuild recreates a dropped table and reindexes every body")
    func bodyRebuild() throws {
        let corpus = try seeded()
        defer { corpus.destroy() }
        try corpus.db.run("DROP TABLE documents_body_fts")

        let result = try IndexRebuild.rebuildBody(corpus.db, now: now)

        guard case .indexed(let counts) = result else {
            Issue.record("expected an indexed result, got \(result)")
            return
        }
        #expect(counts.indexed == 2)
        #expect(counts.errors == 0)
        let hit = try corpus.db.get(
            "SELECT rowid FROM documents_body_fts WHERE documents_body_fts MATCH 'navigation'")?
            .int("rowid")
        #expect(hit == (try corpus.docId("swiftui/navigationstack")))
    }

    @Test("body rebuild on an empty corpus returns the error result")
    func bodyEmpty() throws {
        let corpus = try MaintenanceCorpus.make("rebuild-empty")
        defer { corpus.destroy() }
        let result = try IndexRebuild.rebuildBody(corpus.db, now: now)
        guard case .error(let message) = result else {
            Issue.record("expected the empty-corpus error result, got \(result)")
            return
        }
        #expect(message.contains("No document sections found"))
    }
}
