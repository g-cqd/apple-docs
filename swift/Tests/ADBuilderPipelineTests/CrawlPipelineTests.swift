// Gate for CrawlPipeline — the persist boundary. The pure mapping (ADBuilder.NormalizedPage →
// ADWrite.NormalizedDoc) is checked field-for-field; the full persist is exercised against a fresh
// migrated ADDB database (map → CrawlPersist → read the documents + document_sections rows back).
//
// Split into one @Test per mapped collection / persisted table (file-scope typed fixtures, shared
// persist helper) to stay inside the package's 100 ms type-check budget — the two-body form tripped
// the hard gate.

import ADBuilder
import ADDB
import ADSQLModel
import ADWrite
import Foundation
import Testing

@testable import ADBuilderPipeline

private let samplePage: NormalizedPage = NormalizedPage(
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

/// The pure mapping under test, computed once for the field-for-field checks.
private let mappedDoc: NormalizedDoc = CrawlPipeline.normalizedDoc(samplePage)

struct CrawlPipelineTests {
    @Test func mapsDocumentFieldsToADWriteDoc() {
        #expect(mappedDoc.document.key == "swift-org/install")
        #expect(mappedDoc.document.sourceType == "swift-org")
        #expect(mappedDoc.document.title == "Install")
        #expect(mappedDoc.document.abstractText == "Get Swift.")
        #expect(mappedDoc.document.headings == "Linux")
    }

    @Test func mapsSectionsFieldForField() {
        #expect(mappedDoc.sections.count == 1)
        #expect(mappedDoc.sections[0].sectionKind == "discussion")
        #expect(mappedDoc.sections[0].heading == "Linux")
        #expect(mappedDoc.sections[0].contentText == "apt install swift.")
    }

    @Test func mapsRelationshipsFieldForField() {
        #expect(mappedDoc.relationships.count == 1)
        #expect(mappedDoc.relationships[0].toKey == "swift-org/about")
        #expect(mappedDoc.relationships[0].relationType == "see_also")
    }

    /// Persists the sample page into a fresh migrated DB and reads back the three affected tables
    /// (`SQLRow`s are self-contained, so the temp DB can close before the asserts run).
    private func persistedRows() throws -> (documents: [SQLRow], sections: [SQLRow], relationships: [SQLRow]) {
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
            samplePage, into: db, rootId: rootId, path: "/swift-org/install",
            hashes: .init(content: "c1", rawPayload: "r1"), now: now)

        let documents =
            try db
            .prepare("SELECT title, source_type FROM documents WHERE key = $k")
            .all(["k": .text("swift-org/install")])
        let sections =
            try db
            .prepare("SELECT content_text FROM document_sections WHERE heading = $h")
            .all(["h": .text("Linux")])
        let relationships =
            try db
            .prepare("SELECT to_key, relation_type FROM document_relationships WHERE from_key = $k")
            .all(["k": .text("swift-org/install")])
        return (documents: documents, sections: sections, relationships: relationships)
    }

    @Test func persistsDocumentRow() throws {
        let documents = try persistedRows().documents
        #expect(documents.count == 1)
        if let row = documents.first {
            #expect(row["title"] == .text("Install"))
            #expect(row["source_type"] == .text("swift-org"))
        }
    }

    @Test func persistsSectionRows() throws {
        let sections = try persistedRows().sections
        #expect(sections.count == 1)
        #expect(sections.first?["content_text"] == .text("apt install swift."))
    }

    @Test func persistsRelationshipRows() throws {
        // The relationship maps through too; from_key falls back to the document key.
        let relationships = try persistedRows().relationships
        #expect(relationships.count == 1)
        #expect(relationships.first?["to_key"] == .text("swift-org/about"))
        #expect(relationships.first?["relation_type"] == .text("see_also"))
    }
}
