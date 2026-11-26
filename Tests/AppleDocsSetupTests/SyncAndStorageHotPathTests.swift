import AppleDocsContent
import AppleDocsCore
import AppleDocsPipeline
import AppleDocsSources
import AppleDocsStorage
import Testing

@Suite("Hot-path storage & sync fixes (section zstd, relationship replacement, batching)")
struct SyncAndStorageHotPathTests {
    @Test func `SyncPipeline replaces removed relationships on page update and compresses bulky sections`() throws {
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let root = CorpusRootRecord(slug: "swiftui", displayName: "SwiftUI", kind: "framework", sourceType: .appleDocC)
        let key = try DocumentKey("swiftui/view")
        let oldChild = try DocumentKey("swiftui/oldchild")
        let newChild = try DocumentKey("swiftui/newchild")
        let bulkyText = String(repeating: "SwiftUI declarative view hierarchy layout protocol. ", count: 40)

        let v1 = ConvertedDocument(
            document: DocumentRecord(key: key, title: "View", framework: "swiftui"),
            sections: [DocumentSectionRecord(sectionKind: "discussion", heading: "Overview", contentText: bulkyText)],
            relationships: [DocumentRelationshipRecord(fromKey: key, toKey: oldChild, relationType: "child")]
        )
        _ = try SyncPipeline.ingest(payloads: [SourcePayload(converted: v1)], root: root, into: store)
        #expect(try store.outgoingRelationships(from: key).map(\.toKey) == [oldChild])

        // Bulky section should be stored zstd-compressed on disk while reading back identically.
        let rawCell = try #require(
            try store.connection.queryOne(
                "SELECT typeof(content_text), length(content_text) FROM document_sections"
            )
        )
        #expect(try rawCell.text(at: 0) == "blob")
        #expect(try rawCell.integer(at: 1) < Int64(bulkyText.utf8.count))
        #expect(try store.sections(forKey: key).first?.contentText == bulkyText)

        // Update page with `oldChild` removed and `newChild` added: `oldChild` edge must be purged.
        let v2 = ConvertedDocument(
            document: DocumentRecord(key: key, title: "View", framework: "swiftui"),
            sections: [DocumentSectionRecord(sectionKind: "discussion", heading: "Overview", contentText: "Short.")],
            relationships: [DocumentRelationshipRecord(fromKey: key, toKey: newChild, relationType: "child")]
        )
        _ = try SyncPipeline.ingest(payloads: [SourcePayload(converted: v2)], root: root, into: store)
        #expect(try store.outgoingRelationships(from: key).map(\.toKey) == [newChild])

        // Tiny section should stay plain text when compression does not save bytes.
        let tinyCell = try #require(
            try store.connection.queryOne("SELECT typeof(content_text) FROM document_sections")
        )
        #expect(try tinyCell.text(at: 0) == "text")
        #expect(try store.sections(forKey: key).first?.contentText == "Short.")
    }
}
