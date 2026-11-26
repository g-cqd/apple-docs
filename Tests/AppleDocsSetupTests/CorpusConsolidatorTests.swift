import AppleDocsCore
import AppleDocsPipeline
import AppleDocsSources
import AppleDocsStorage
import Testing

@Suite("CorpusConsolidator (Bun commands/consolidate.js)")
struct CorpusConsolidatorTests {
    @Test func `cleans invalid + cross-adapter failed entries, sweeps orphan relationships, and retries failed pages`()
        async throws
    {
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        try store.upsertRoot(
            CorpusRootRecord(slug: "swiftui", displayName: "SwiftUI", kind: "framework", sourceType: .appleDocC)
        )
        try store.upsertRoot(
            CorpusRootRecord(
                slug: "swift-compiler",
                displayName: "Swift Compiler",
                kind: "tooling",
                sourceType: .swiftDocC
            )
        )
        let db = store.connection
        // 1. Operator false positive
        try db.execute(
            "INSERT INTO crawl_state (path, root_slug, status, error) VALUES ('swiftui/._(_:_:)', 'swiftui', 'failed', '404')"
        )
        // 2. Cross-adapter false positive (swift-compiler is swift-docc, not apple-docc)
        try db.execute(
            "INSERT INTO crawl_state (path, root_slug, status, error) VALUES ('swift-compiler/foo', 'swiftui', 'failed', '404')"
        )
        // 3. Transient failure that recovers on retry
        try db.execute(
            "INSERT INTO crawl_state (path, root_slug, status, error) VALUES ('swiftui/view', 'swiftui', 'failed', '503')"
        )
        // 4. Orphan relationship
        try store.upsertRelationship(
            DocumentRelationshipRecord(
                fromKey: try DocumentKey("swiftui/ghost"),
                toKey: try DocumentKey("swiftui/view"),
                relationType: "child"
            )
        )

        let transport = RecordingTransport()
        transport.set(
            "https://developer.apple.com/tutorials/data/documentation/swiftui/view.json",
            body: #"{"metadata":{"title":"View"}}"#,
            etag: "\"v1\""
        )
        let report = try await CorpusConsolidator.run(
            client: UpstreamHTTPClient(transport: transport),
            store: store,
            concurrency: 4
        )
        #expect(report.analyzed == 3)
        #expect(report.cleanedInvalid == 1)
        #expect(report.cleanedCrossAdapter == 1)
        #expect(report.orphanRelationshipsRemoved == 1)
        #expect(report.retriedRecovered == 1)
        #expect(try store.documentCount() == 1)
    }
}
