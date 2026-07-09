// Xcode-docs enrichment gate: `MobileAssetDocs.enrichFromAsset` row outcomes over
// a SYNTHESIZED asset-shaped fixture (the real MobileAsset's `documents` +
// `attributes` STRICT schema) against a freshly migrated corpus seeded through the
// real persist — the MaintenanceCorpus idiom. Pins the JS merge discipline
// (src/sources/mobileasset-docs.js): NULL-guarded usr/platform backfill, novel
// inserts through the documents upsert (FTS triggers + sections + root), anchor
// and malformed-JSON skips, dry-run purity, and idempotent re-runs.

import ADStorage
import Foundation
import Testing

@testable import ADWrite

@Suite("Xcode-docs enrichment", .serialized)
struct XcodeDocsEnrichTests {
    private static let now = "2026-07-09T00:00:00.000Z"

    /// The asset `document` JSON blobs (real MobileAsset field shapes — `introduced` carries the
    /// IEEE noise Apple actually ships; `macCatalyst` is spelled as in the asset, which the JS
    /// PLATFORM_KEYS never matches).
    private enum Blob {
        static let view = """
            {"external_id":"s:7SwiftUI4ViewP","platforms":[{"platform":"iOS","introduced":13,"deprecated":false}]}
            """
        static let text = """
            {"symbol":{"preciseIdentifier":"s:7SwiftUI4TextV"},"platforms":[\
            {"platform":"iOS","introduced":17.199999999999999},\
            {"platform":"macCatalyst","introduced":13},\
            {"platform":"macOS","introduced":10.15}]}
            """
        static let uiview = """
            {"roleHeading":"Class"}
            """
        static let novel = """
            {"external_id":"s:12NewFramework8NewThingV","fileName":"Fallback","modules":["New Framework"],\
            "kind":"symbol","role":"symbol","roleHeading":"Structure",\
            "platforms":[{"platform":"iOS","introduced":26}]}
            """
        static let hig = "{}"
    }

    /// One corpus + one synthesized asset; caller destroys the corpus dir.
    private func makeFixture() throws -> (corpus: MaintenanceCorpus, assetDbPath: String) {
        let corpus = try MaintenanceCorpus.make("enrich")
        let rootId = try corpus.addRoot(slug: "swiftui", now: Self.now)
        // swiftui/view: platforms already set by the crawl (stays authoritative), usr NULL.
        try addDoc(corpus, rootId: rootId, key: "swiftui/view", platformsJson: #"{"ios":"13.0"}"#, minIos: "13.0")
        // swiftui/text: both usr + platforms NULL → both backfill.
        try addDoc(corpus, rootId: rootId, key: "swiftui/text")
        // uikit/uiview: usr pre-set (never overwritten); the asset page carries no usr anyway.
        try addDoc(corpus, rootId: rootId, key: "uikit/uiview")
        try corpus.db.run(
            "UPDATE documents SET usr = 'c:objc(cs)UIView' WHERE key = 'uikit/uiview'")

        let assetDbPath = corpus.dir.appendingPathComponent("asset-index.sql").path
        try makeAssetDb(
            at: assetDbPath,
            rows: [
                ("/documentation/SwiftUI/View", Blob.view),
                ("/documentation/SwiftUI/View#Overview", "{}"),  // anchor → skipped
                ("/documentation/SwiftUI/Text", Blob.text),
                ("/documentation/UIKit/UIView", Blob.uiview),
                ("/documentation/NewFramework/NewThing", Blob.novel),
                ("/design/Human-Interface-Guidelines/foo", Blob.hig),
                ("/documentation/Broken/Blob", "{not json")  // malformed → page counted, skipped
            ],
            chunks: [
                AssetChunk(
                    assetId: "/documentation/NewFramework/NewThing", index: 0, title: "New Thing",
                    content: "Intro text."),
                AssetChunk(
                    assetId: "/documentation/NewFramework/NewThing", index: 1, title: nil, content: "More discussion.")
            ])
        return (corpus, assetDbPath)
    }

    @Test("apply: backfills, novel inserts, roots, sections, FTS")
    func applyMerge() throws {
        let (corpus, assetDbPath) = try makeFixture()
        defer { corpus.destroy() }
        let stats = try runEnrich(corpus, assetDbPath, apply: true)

        #expect(stats.pages == 6)
        #expect(stats.anchorsSkipped == 1)
        #expect(stats.usrBackfilled == 2)  // view + text (uiview has usr pre-set / none in asset)
        #expect(stats.platformsBackfilled == 1)  // text only — view's crawl platforms stay
        #expect(stats.novelInserted == 2)  // NewThing + the HIG page

        // usr backfill; the crawl's platforms_json is untouched.
        let view = try corpus.db.get("SELECT usr, platforms_json FROM documents WHERE key = 'swiftui/view'")
        #expect(view?.text("usr") == "s:7SwiftUI4ViewP")
        #expect(view?.text("platforms_json") == #"{"ios":"13.0"}"#)

        // Platform backfill: asset order, macCatalyst skipped, IEEE noise formatted, nums encoded.
        let text = try corpus.db.get(
            """
            SELECT usr, platforms_json, min_ios, min_ios_num, min_macos, min_macos_num
            FROM documents WHERE key = 'swiftui/text'
            """)
        #expect(text?.text("usr") == "s:7SwiftUI4TextV")  // symbol.preciseIdentifier fallback
        #expect(text?.text("platforms_json") == #"{"ios":"17.2","macos":"10.15"}"#)
        #expect(text?.text("min_ios") == "17.2")
        #expect(text?.int("min_ios_num") == 17_002_000)
        #expect(text?.text("min_macos") == "10.15")
        #expect(text?.int("min_macos_num") == 10_015_000)

        // Pre-set usr survives.
        let uiview = try corpus.db.get("SELECT usr FROM documents WHERE key = 'uikit/uiview'")
        #expect(uiview?.text("usr") == "c:objc(cs)UIView")

        try assertNovelDocument(corpus)
        try assertNovelSections(corpus)
        try assertNovelRoots(corpus)
    }

    /// The novel documents row (split small to stay within the type-check budget).
    private func assertNovelDocument(_ corpus: MaintenanceCorpus) throws {
        let novel = try corpus.db.get(
            """
            SELECT title, framework, url, language, source_type, source_metadata, usr,
                   platforms_json, min_ios_num
            FROM documents WHERE key = 'newframework/newthing'
            """)
        let expectedUrl: String = "https://developer.apple.com/documentation/NewFramework/NewThing"
        let expectedMetadata: String = #"{"enrichedFrom":"xcode-mobileasset"}"#
        let expectedPlatforms: String = #"{"ios":"26.0"}"#
        let expectedNum: Int64 = 26_000_000
        #expect(novel?.text("title") == "New Thing")  // chunk 0's title beats fileName
        #expect(novel?.text("framework") == "newframework")
        #expect(novel?.text("url") == expectedUrl)
        #expect(novel?.text("language") == "swift")
        #expect(novel?.text("source_type") == "apple-docc")
        #expect(novel?.text("source_metadata") == expectedMetadata)
        #expect(novel?.text("usr") == "s:12NewFramework8NewThingV")
        #expect(novel?.text("platforms_json") == expectedPlatforms)
        #expect(novel?.int("min_ios_num") == expectedNum)
    }

    /// Sections from the attributes chunks, in chunk order; the FTS row via the insert trigger.
    private func assertNovelSections(_ corpus: MaintenanceCorpus) throws {
        let sections = try corpus.db.all(
            """
            SELECT s.section_kind, s.heading, s.content_text, s.sort_order
            FROM document_sections s JOIN documents d ON d.id = s.document_id
            WHERE d.key = 'newframework/newthing' ORDER BY s.sort_order
            """)
        #expect(sections.count == 2)
        #expect(sections.first?.text("section_kind") == "discussion")
        #expect(sections.first?.text("heading") == "New Thing")
        #expect(sections.first?.text("content_text") == "Intro text.")
        #expect(sections.last?.text("heading") == nil)
        #expect(sections.last?.text("content_text") == "More discussion.")
        let fts = try corpus.db.get(
            """
            SELECT COUNT(*) AS c FROM documents_fts f
            JOIN documents d ON d.id = f.rowid WHERE d.key = 'newframework/newthing'
            """)
        #expect(fts?.int("c") == 1)
    }

    /// The novel roots (modules[0] display name; the design slug derives source_type 'hig') and
    /// the malformed blob's absence.
    private func assertNovelRoots(_ corpus: MaintenanceCorpus) throws {
        let root = try corpus.db.get(
            "SELECT display_name, kind, source, source_type FROM roots WHERE slug = 'newframework'")
        #expect(root?.text("display_name") == "New Framework")
        #expect(root?.text("kind") == "framework")
        #expect(root?.text("source") == "xcode-mobileasset")
        #expect(root?.text("source_type") == "apple-docc")
        let design = try corpus.db.get("SELECT source_type FROM roots WHERE slug = 'design'")
        #expect(design?.text("source_type") == "hig")
        let broken = try corpus.db.get("SELECT COUNT(*) AS c FROM documents WHERE key = 'broken/blob'")
        #expect(broken?.int("c") == 0)
    }

    @Test("dry-run counts without writing")
    func dryRun() throws {
        let (corpus, assetDbPath) = try makeFixture()
        defer { corpus.destroy() }
        let stats = try runEnrich(corpus, assetDbPath, apply: false)
        #expect(stats.usrBackfilled == 2)
        #expect(stats.platformsBackfilled == 1)
        #expect(stats.novelInserted == 2)
        let usrCount = try corpus.db.get(
            "SELECT COUNT(*) AS c FROM documents WHERE usr IS NOT NULL")
        #expect(usrCount?.int("c") == 1)  // only the pre-set uikit/uiview
        let novel = try corpus.db.get(
            "SELECT COUNT(*) AS c FROM documents WHERE key = 'newframework/newthing'")
        #expect(novel?.int("c") == 0)
    }

    @Test("re-running is idempotent")
    func idempotent() throws {
        let (corpus, assetDbPath) = try makeFixture()
        defer { corpus.destroy() }
        _ = try runEnrich(corpus, assetDbPath, apply: true)
        let again = try runEnrich(corpus, assetDbPath, apply: true)
        #expect(again.pages == 6)
        #expect(again.usrBackfilled == 0)
        #expect(again.platformsBackfilled == 0)
        #expect(again.novelInserted == 0)
        let docs = try corpus.db.get("SELECT COUNT(*) AS c FROM documents")
        #expect(docs?.int("c") == 5)  // 3 seeded + 2 novel, no duplicates
    }

    @Test("a missing asset db throws assetOpen")
    func missingAsset() throws {
        let corpus = try MaintenanceCorpus.make("enrich-missing")
        defer { corpus.destroy() }
        #expect(throws: XcodeDocsEnrichError.self) {
            _ = try runEnrich(corpus, corpus.dir.appendingPathComponent("nope.sql").path, apply: false)
        }
    }

    // MARK: - fixture plumbing

    /// Open the corpus the way the verb does (`StorageConnection(path:writable: true)`) and merge.
    private func runEnrich(
        _ corpus: MaintenanceCorpus, _ assetDbPath: String, apply: Bool
    ) throws -> XcodeDocsEnrichStats {
        let connection = try #require(StorageConnection(path: corpus.dbPath, writable: true))
        return try MobileAssetDocs.enrichFromAsset(
            connection, assetDbPath: assetDbPath, apply: apply, now: Self.now)
    }

    /// Persist one document through the real crawl persist (pages + documents + a section).
    private func addDoc(
        _ corpus: MaintenanceCorpus, rootId: Int64, key: String, platformsJson: String? = nil,
        minIos: String? = nil
    ) throws {
        let doc = NormalizedDoc(
            document: NormalizedDocument(
                sourceType: "apple-docc", key: key, title: "Title of \(key)",
                framework: key.split(separator: "/").first.map(String.init),
                url: "https://developer.apple.com/documentation/\(key)",
                platformsJson: platformsJson, minIos: minIos),
            sections: [
                NormalizedSection(sectionKind: "abstract", contentText: "Abstract.", sortOrder: 0)
            ],
            relationships: [])
        try CrawlPersist.persistNormalized(
            corpus.db, rootId: rootId, path: key, doc,
            hashes: .init(content: "c-\(key)", rawPayload: "r-\(key)"), now: Self.now)
    }

    /// One synthesized `attributes` row (a rendered-Markdown chunk).
    private struct AssetChunk {
        let assetId: String
        let index: Int
        let title: String?
        let content: String?
    }

    /// Build the asset-shaped SQLite fixture: the real MobileAsset `documents` + `attributes`
    /// STRICT tables (document blobs stored as BLOB, as Xcode ships them). Plain rollback journal
    /// (`writerPragmas: false`) so the immutable read-only open sees every row without a WAL.
    private func makeAssetDb(
        at path: String, rows: [(String, String)], chunks: [AssetChunk]
    ) throws {
        let db = try SQLiteWriteConnection(path: path, writerPragmas: false)
        defer { db.close() }
        try db.run("CREATE TABLE documents (asset_id TEXT PRIMARY KEY, document BLOB) STRICT")
        try db.run(
            """
            CREATE TABLE attributes (asset_id TEXT, vector_id INTEGER, content_hash TEXT,
              chunk_index INTEGER, type TEXT, framework TEXT, title TEXT, content TEXT,
              PRIMARY KEY (asset_id, vector_id)) STRICT
            """)
        for (assetId, document) in rows {
            try db.run(
                "INSERT INTO documents (asset_id, document) VALUES ($a, $d)",
                ["a": .text(assetId), "d": .blob(Array(document.utf8))])
        }
        for chunk in chunks {
            try db.run(
                """
                INSERT INTO attributes (asset_id, vector_id, chunk_index, title, content)
                VALUES ($a, $v, $i, $t, $c)
                """,
                [
                    "a": .text(chunk.assetId), "v": .integer(Int64(chunk.index)),
                    "i": .integer(Int64(chunk.index)),
                    "t": chunk.title.map(SQLiteValue.text) ?? .null,
                    "c": chunk.content.map(SQLiteValue.text) ?? .null
                ])
        }
    }
}
