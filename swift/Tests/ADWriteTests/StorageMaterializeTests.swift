// `storage materialize` gate (StorageMaterialize — the storageMaterialize
// port): the markdown/html render legs (via the same in-process renderers the
// JS routes through), the roots filter, the raw-json decompression leg, and
// the compacted-corpus decode divergence (sections read through the codec).

import ADStorage
import Foundation
import Testing

@testable import ADWrite

@Suite("StorageMaterialize — storage materialize")
struct StorageMaterializeTests {
    private let now = "2026-07-01T00:00:00.000Z"

    @Test("markdown renders every document to <dataDir>/markdown/<key>.md")
    func markdown() throws {
        let corpus = try MaintenanceCorpus.make("mat-md")
        defer { corpus.destroy() }
        let rootId = try corpus.addRoot(slug: "swiftui", now: now)
        try corpus.addDoc(rootId: rootId, key: "swiftui/view", body: "A view is composable.", now: now)
        try corpus.addDoc(rootId: rootId, key: "swiftui/text", body: "Text renders glyphs.", now: now)

        let result = try StorageMaterialize.run(corpus.db, dataDir: corpus.dataDir, format: .markdown)

        #expect(result == .rendered(materialized: 2, format: .markdown))
        let path = corpus.dir.appendingPathComponent("markdown/swiftui/view.md").path
        let text = try String(contentsOfFile: path, encoding: .utf8)
        // Front matter (title + raw framework fallback + path) then the body.
        #expect(text.hasPrefix("---\n"))
        #expect(text.contains("title: Title of swiftui/view"))
        #expect(text.contains("framework: swiftui"))
        #expect(text.contains("path: swiftui/view"))
        #expect(text.contains("A view is composable."))
    }

    @Test("the roots filter narrows to active pages of the named roots")
    func rootsFilter() throws {
        let corpus = try MaintenanceCorpus.make("mat-roots")
        defer { corpus.destroy() }
        let swiftui = try corpus.addRoot(slug: "swiftui", now: now)
        let combine = try corpus.addRoot(slug: "combine", now: now)
        try corpus.addDoc(rootId: swiftui, key: "swiftui/view", body: "prose", now: now)
        try corpus.addDoc(rootId: combine, key: "combine/publisher", body: "prose", now: now)

        let result = try StorageMaterialize.run(
            corpus.db, dataDir: corpus.dataDir, format: .markdown, roots: ["combine"])

        #expect(result == .rendered(materialized: 1, format: .markdown))
        #expect(
            FileManager.default.fileExists(
                atPath: corpus.dir.appendingPathComponent("markdown/combine/publisher.md").path))
        #expect(
            !FileManager.default.fileExists(
                atPath: corpus.dir.appendingPathComponent("markdown/swiftui/view.md").path))
    }

    @Test("html renders the <h1> + section fragments")
    func html() throws {
        let corpus = try MaintenanceCorpus.make("mat-html")
        defer { corpus.destroy() }
        let rootId = try corpus.addRoot(slug: "swiftui", now: now)
        try corpus.addDoc(rootId: rootId, key: "swiftui/view", body: "A view is composable.", now: now)

        let result = try StorageMaterialize.run(corpus.db, dataDir: corpus.dataDir, format: .html)

        #expect(result == .rendered(materialized: 1, format: .html))
        let text = try String(
            contentsOfFile: corpus.dir.appendingPathComponent("html/swiftui/view.html").path,
            encoding: .utf8)
        #expect(text.contains("<h1>Title of swiftui/view</h1>"))
        #expect(text.contains("A view is composable."))
    }

    @Test("raw-json inflates document_raw payloads to loose files")
    func rawJson() throws {
        let corpus = try MaintenanceCorpus.make("mat-raw")
        defer { corpus.destroy() }
        let rootId = try corpus.addRoot(slug: "swiftui", now: now)
        try corpus.addDoc(rootId: rootId, key: "swiftui/view", body: "prose", now: now)
        let payload =
            "{\"identifier\":\"swiftui/view\",\"blob\":\""
            + String(repeating: "raw payload text ", count: 50) + "\"}"
        let encoded = SectionCodec.encode(payload)  // long → a zstd BLOB
        guard case .blob = encoded else {
            Issue.record("expected the seed payload to compress")
            return
        }
        try corpus.db.run(
            "INSERT OR REPLACE INTO document_raw(document_id, raw) VALUES ($id, $raw)",
            ["id": .integer(try corpus.docId("swiftui/view")), "raw": encoded])

        let result = try StorageMaterialize.run(corpus.db, dataDir: corpus.dataDir, format: .rawJson)

        #expect(result == .rawJson(materialized: 1))
        let text = try String(
            contentsOfFile: corpus.dir.appendingPathComponent("raw-json/swiftui/view.json").path,
            encoding: .utf8)
        #expect(text == payload)
    }

    @Test("raw-json on a corpus with no payloads materializes nothing")
    func rawJsonEmpty() throws {
        let corpus = try MaintenanceCorpus.make("mat-raw-empty")
        defer { corpus.destroy() }
        let result = try StorageMaterialize.run(corpus.db, dataDir: corpus.dataDir, format: .rawJson)
        #expect(result == .rawJson(materialized: 0))
    }

    @Test("a compacted corpus still materializes readable markdown (codec divergence)")
    func compactedCorpus() throws {
        let corpus = try MaintenanceCorpus.make("mat-compacted")
        defer { corpus.destroy() }
        let rootId = try corpus.addRoot(slug: "swiftui", now: now)
        let body = String(repeating: "Long compressible discussion prose. ", count: 40)
        try corpus.addDoc(rootId: rootId, key: "swiftui/view", body: body, now: now)
        _ = try StorageCompact.run(corpus.db, now: now)

        let result = try StorageMaterialize.run(corpus.db, dataDir: corpus.dataDir, format: .markdown)

        #expect(result == .rendered(materialized: 1, format: .markdown))
        let text = try String(
            contentsOfFile: corpus.dir.appendingPathComponent("markdown/swiftui/view.md").path,
            encoding: .utf8)
        #expect(text.contains("Long compressible discussion prose."))
    }
}
