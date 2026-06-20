// Gate for CrawlPipeline — the persist boundary. The pure mapping (ADBuilder.NormalizedPage →
// ADWrite.NormalizedDoc) is checked field-for-field; the full persist is exercised against a fresh
// migrated ADDB database (map → CrawlPersist → read the documents + document_sections rows back).

import ADBuilder
import ADDB
import ADSQLModel
import ADWrite
import Foundation
import Testing

@testable import ADBuilderPipeline

struct CrawlPipelineTests {
    private func samplePage() -> NormalizedPage {
        NormalizedPage(
            document: ADBuilder.NormalizedDocument(
                sourceType: "swift-org", key: "swift-org/install", title: "Install",
                framework: "swift-org", url: "https://swift.org/install", abstractText: "Get Swift.",
                headings: "Linux"),
            sections: [
                ADBuilder.NormalizedSection(
                    sectionKind: "discussion", heading: "Linux", contentText: "apt install swift.",
                    sortOrder: 0)
            ],
            relationships: [
                ADBuilder.NormalizedRelationship(
                    toKey: "swift-org/about", relationType: "see_also", sortOrder: 0)
            ])
    }

    @Test func mapsPageToADWriteDocFieldForField() {
        let doc = CrawlPipeline.normalizedDoc(samplePage())
        #expect(doc.document.key == "swift-org/install")
        #expect(doc.document.sourceType == "swift-org")
        #expect(doc.document.title == "Install")
        #expect(doc.document.abstractText == "Get Swift.")
        #expect(doc.document.headings == "Linux")
        #expect(doc.sections.count == 1)
        #expect(doc.sections[0].sectionKind == "discussion")
        #expect(doc.sections[0].heading == "Linux")
        #expect(doc.sections[0].contentText == "apt install swift.")
        #expect(doc.relationships.count == 1)
        #expect(doc.relationships[0].toKey == "swift-org/about")
        #expect(doc.relationships[0].relationType == "see_also")
    }

    @Test func persistsToFreshDatabase() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("adbuilderpipeline-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let db = try Database.open(
            at: dir.appendingPathComponent("crawl.adsql").path, options: DatabaseOptions())
        defer { db.close() }
        _ = try migrateSchema(db)

        let now = "2026-06-20T00:00:00.000Z"
        let rootId = try CrawlPersist.upsertRoot(
            db, slug: "swift-org", displayName: "Swift.org", kind: "collection", source: "swift-org",
            now: now)

        try CrawlPipeline.persist(
            samplePage(), into: db, rootId: rootId, path: "/swift-org/install",
            hashes: .init(content: "c1", rawPayload: "r1"), now: now)

        let documents = try db.prepare(
            "SELECT title, source_type FROM documents WHERE key = $k"
        ).all(["k": .text("swift-org/install")])
        #expect(documents.count == 1)
        if let row = documents.first {
            #expect(row["title"] == .text("Install"))
            #expect(row["source_type"] == .text("swift-org"))
        }

        let sections = try db.prepare(
            "SELECT content_text FROM document_sections WHERE heading = $h"
        ).all(["h": .text("Linux")])
        #expect(sections.count == 1)
        #expect(sections.first?["content_text"] == .text("apt install swift."))
    }
}
