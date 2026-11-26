import AppleDocsCore
import AppleDocsStorage
import Testing

@Suite("CorpusStore & Swift v1 Schema")
struct CorpusStoreTests {
    @Test func `initializes Swift v1 schema, round-trips roots, documents, sections, and relationships`() throws {
        let store = try CorpusStore(path: ":memory:")
        #expect(try store.connection.userVersion() == CorpusSchemaV1.userVersion)

        let root = CorpusRootRecord(
            slug: "swiftui",
            displayName: "SwiftUI",
            kind: "framework",
            sourceType: .appleDocC,
            seedPath: "swiftui",
            pageCount: 2,
            indexETag: "\"etag-1\""
        )
        try store.upsertRoot(root)
        let listed = try store.listRoots(kind: "framework")
        #expect(listed == [root])

        let viewKey = try DocumentKey("swiftui/view")
        let stackKey = try DocumentKey("swiftui/navigationstack")
        let doc = DocumentRecord(
            key: stackKey,
            sourceType: .appleDocC,
            title: "NavigationStack",
            kind: "struct",
            role: "symbol",
            roleHeading: "Structure",
            framework: "swiftui",
            language: "swift",
            usr: "s:7SwiftUI15NavigationStackV",
            abstractText: "A view that displays a root view and enables you to present additional views.",
            declarationText: "struct NavigationStack<Data, Root> : View",
            headings: "Overview\nCreating a navigation stack",
            availability: PlatformAvailability(ios: "16.0", macos: "13.0", watchos: "9.0", tvos: "16.0"),
            urlDepth: 1
        )
        let docID = try store.upsertDocument(doc)
        #expect(docID > 0)
        #expect(try store.documentCount() == 1)
        #expect(try store.document(forKey: stackKey) == doc)

        let sections = [
            DocumentSectionRecord(
                sectionKind: "overview",
                heading: "Overview",
                contentText: "Push views onto a stack.",
                sortOrder: 0
            ),
            DocumentSectionRecord(
                sectionKind: "discussion",
                heading: "Deep links",
                contentText: "Bind a NavigationPath.",
                sortOrder: 1
            )
        ]
        try store.replaceSections(forDocumentID: docID, sections: sections)
        #expect(try store.sections(forKey: stackKey) == sections)

        let rel = DocumentRelationshipRecord(
            fromKey: stackKey,
            toKey: viewKey,
            relationType: "conforms-to",
            section: "Conforms To"
        )
        try store.upsertRelationship(rel)
        #expect(try store.outgoingRelationships(from: stackKey) == [rel])
    }

    @Test func `maintains FTS5 and external-content trigram triggers cleanly across rename and delete`() throws {
        let store = try CorpusStore(path: ":memory:")
        let key = try DocumentKey("swiftui/navigationview")

        let original = DocumentRecord(
            key: key,
            title: "NavigationView",
            abstractText: "Legacy container for navigation.",
            availability: PlatformAvailability(ios: "13.0", macos: "10.15")
        )
        try store.upsertDocument(original)

        let beforeTrigram = try store.connection.query(
            "SELECT rowid FROM documents_trigram WHERE documents_trigram MATCH ?",
            bindings: [.text("\"NavigationView\"")]
        )
        #expect(beforeTrigram.count == 1)

        // Rename title: canonical external-content delete trigger must purge old trigram postings.
        let renamed = DocumentRecord(
            key: key,
            title: "NavigationSplitView",
            abstractText: "Multi-column container for navigation.",
            availability: PlatformAvailability(ios: "16.0", macos: "13.0")
        )
        try store.upsertDocument(renamed)

        let staleTrigram = try store.connection.query(
            "SELECT rowid FROM documents_trigram WHERE documents_trigram MATCH ?",
            bindings: [.text("\"NavigationView\"")]
        )
        #expect(staleTrigram.isEmpty)

        let updatedTrigram = try store.connection.query(
            "SELECT rowid FROM documents_trigram WHERE documents_trigram MATCH ?",
            bindings: [.text("\"NavigationSplitView\"")]
        )
        #expect(updatedTrigram.count == 1)

        // Delete document: both documents_fts and documents_trigram must drop the postings.
        try store.deleteDocument(forKey: key)
        #expect(try store.documentCount() == 0)

        let remainingFTS = try store.connection.query(
            "SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?",
            bindings: [.text("NavigationSplitView")]
        )
        let remainingTrigram = try store.connection.query(
            "SELECT rowid FROM documents_trigram WHERE documents_trigram MATCH ?",
            bindings: [.text("\"NavigationSplitView\"")]
        )
        #expect(remainingFTS.isEmpty)
        #expect(remainingTrigram.isEmpty)
    }

    @Test func `stores numeric platform companions so iOS 10 is greater than iOS 9`() throws {
        let store = try CorpusStore(path: ":memory:")
        try store.upsertDocument(
            DocumentRecord(
                key: try DocumentKey("uikit/oldapi"),
                title: "OldAPI",
                availability: PlatformAvailability(ios: "9.0")
            )
        )
        try store.upsertDocument(
            DocumentRecord(
                key: try DocumentKey("uikit/newapi"),
                title: "NewAPI",
                availability: PlatformAvailability(ios: "10.0")
            )
        )

        let maxIOS9 = try #require(PlatformVersion(parsing: "9.0")).encoded
        let rows = try store.connection.query(
            "SELECT key FROM documents WHERE min_ios_num <= ? ORDER BY key",
            bindings: [.integer(maxIOS9)]
        )
        #expect(rows.count == 1)
        #expect(try rows[0].text(at: 0) == "uikit/oldapi")
    }
}
