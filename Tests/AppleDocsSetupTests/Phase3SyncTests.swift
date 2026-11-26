import AppleDocsContent
import AppleDocsCore
import AppleDocsPipeline
import AppleDocsSearch
import AppleDocsSources
import AppleDocsStorage
import Synchronization
import Testing

@Suite("Phase 3: Upstream HTTP, 11 SourceAdapters, Rich DocC & Resumable SyncOrchestrator")
struct Phase3SyncTests {
    @Test func `UpstreamHTTPClient blocks SSRF/non-HTTPS URLs and retries 429/503 with deterministic backoff`()
        async throws
    {
        for bad in [
            "http://developer.apple.com/documentation/swiftui",
            "https://user:pass@developer.apple.com/doc",
            "https://127.0.0.1/secret",
            "https://localhost/admin",
            "https://169.254.169.254/latest/meta-data/",
            "https://10.0.0.1/internal",
            "https://192.168.1.1/router"
        ] {
            #expect(throws: SourceError.self) {
                try UpstreamHTTPClient.validatePublicHTTPSURL(bad)
            }
        }
        try UpstreamHTTPClient.validatePublicHTTPSURL(
            "https://developer.apple.com/tutorials/data/documentation/swiftui.json",
            allowedHosts: ["developer.apple.com"]
        )

        let transport = MockTransport(responses: [
            UpstreamFetchResponse(statusCode: 429, retryAfterSeconds: 1),
            UpstreamFetchResponse(statusCode: 503),
            UpstreamFetchResponse(statusCode: 200, body: Array("ok".utf8), etag: "\"v1\"")
        ])
        let sleepRecorder = Mutex<[Int]>([])
        let client = UpstreamHTTPClient(
            transport: transport,
            policy: UpstreamHTTPClient.Policy(maxAttempts: 3) { seconds in
                sleepRecorder.withLock { $0.append(seconds) }
            }
        )

        let resp = try await client.get(url: "https://developer.apple.com/tutorials/data/documentation/swiftui.json")
        #expect(resp.statusCode == 200)
        #expect(resp.etag == "\"v1\"")
        #expect(sleepRecorder.withLock { $0 } == [1, 2])
    }

    @Test func `SourceRegistry exposes all 11 upstream sources with valid HTTPS data URLs`() throws {
        let all = SourceRegistry.allAdapters
        #expect(all.count == SourceKind.allCases.count)
        #expect(all.count == 11)
        for adapter in all {
            let seed = try #require(adapter.seedKeys.first)
            let url = try adapter.dataURL(for: seed)
            try UpstreamHTTPClient.validatePublicHTTPSURL(url)
        }
        #expect(WebSourceAdapter.isOperatorSegment("._(_:_:)"))
        #expect(!WebSourceAdapter.isOperatorSegment("navigationstack"))
    }

    @Test func `DocCJSONConverter extracts USR, parameters, callout asides, and topic/relationship edges`() throws {
        let json = """
            {
                "identifier": {"interfaceLanguage": "swift"},
                "metadata": {
                    "title": "NavigationStack",
                    "externalID": "s:7SwiftUI15NavigationStackV",
                    "symbolKind": "struct",
                    "role": "symbol",
                    "roleHeading": "Structure"
                },
                "primaryContentSections": [
                    {
                        "kind": "parameters",
                        "parameters": [
                            {"name": "root", "content": [{"type": "paragraph", "inlineContent": [{"type": "text", "text": "The root view."}]}]}
                        ]
                    },
                    {
                        "kind": "content",
                        "content": [
                            {"type": "aside", "style": "important", "content": [{"type": "paragraph", "inlineContent": [{"type": "text", "text": "Use iOS 16+."}]}]}
                        ]
                    }
                ],
                "topicSections": [
                    {"title": "Managing Path", "identifiers": ["doc://com.apple.SwiftUI/documentation/SwiftUI/NavigationPath", "doc://com.externally.resolved.symbol/s:SH"]}
                ],
                "references": {
                    "doc://com.apple.SwiftUI/documentation/SwiftUI/NavigationPath": {
                        "url": "/documentation/swiftui/navigationpath"
                    }
                }
            }
            """
        let converted = try DocCJSONConverter.convert(
            json: Array(json.utf8),
            key: try DocumentKey("swiftui/navigationstack")
        )
        #expect(converted.document.usr == "s:7SwiftUI15NavigationStackV")
        #expect(
            converted.sections.contains { $0.sectionKind == "parameters" && $0.contentText == "root: The root view." }
        )
        #expect(converted.sections.contains { $0.contentText == "important: Use iOS 16+.\n" })
        #expect(converted.relationships.count == 1)
        #expect(converted.relationships[0].toKey.rawValue == "swiftui/navigationpath")
    }

    @Test
    func `SyncOrchestrator crawls BFS links, skips 304, tombstones after 2 consecutive 404s, and builds embeddings`()
        async throws
    {
        let rootJSON = """
            {
                "metadata": {"title": "NavigationStack"},
                "topicSections": [{"title": "Related", "identifiers": ["doc://a/documentation/swiftui/navigationpath"]}],
                "references": {"doc://a/documentation/swiftui/navigationpath": {"url": "/documentation/swiftui/navigationpath"}}
            }
            """
        let childJSON = #"{"metadata": {"title": "NavigationPath"}}"#

        let transport = MapTransport(routes: [
            "https://developer.apple.com/tutorials/data/documentation/swiftui/navigationstack.json":
                UpstreamFetchResponse(statusCode: 200, body: Array(rootJSON.utf8), etag: "\"e1\""),
            "https://developer.apple.com/tutorials/data/documentation/swiftui/navigationpath.json":
                UpstreamFetchResponse(statusCode: 200, body: Array(childJSON.utf8), etag: "\"e2\"")
        ])
        let client = UpstreamHTTPClient(transport: transport)
        let adapter = SourceRegistry.adapter(for: .appleDocC)
        let store = try CorpusStore(path: ":memory:")

        // Run 1: crawls seed + discovered child
        let seed = try DocumentKey("swiftui/navigationstack")
        let run1 = try await SyncOrchestrator.sync(
            adapter: adapter,
            seeds: [seed],
            client: client,
            into: store,
            options: SyncOrchestrator.Options(maxPages: 10, maxDepth: 1, tombstoneThreshold: 2)
        )
        #expect(run1.fetchedModified == 2)
        #expect(run1.discoveredQueued == 1)
        #expect(try store.documentCount() == 2)
        #expect(try store.outgoingRelationships(from: seed).count == 1)
        let rootRow = try #require(try store.listRoots().first { $0.slug == "swiftui" })
        #expect(rootRow.pageCount == 2)
        #expect(rootRow.displayName == "NavigationStack")

        // Build binary embeddings for both documents
        let tokJSON = """
            {"normalizer":{"type":"BertNormalizer"},"pre_tokenizer":{"type":"BertPreTokenizer"},
             "model":{"type":"WordPiece","vocab":{"[UNK]":0,"navigationstack":1,"navigationpath":2}}}
            """
        let embedder = Model2VecEmbedder(
            tokenizer: try WordPieceTokenizer(tokenizerJSON: Array(tokJSON.utf8)),
            matrix: Model2VecEmbedder.EmbeddingMatrix(rows: 3, dims: 8, weights: [Float](repeating: 1.0, count: 24))
        )
        let built = try await ChunkEmbeddingIndexer.run(store: store, embedder: embedder, modelName: "test")
        #expect(built.documents == 2)
        #expect(try await ChunkEmbeddingIndexer.run(store: store, embedder: embedder, modelName: "test").documents == 0)

        // Run 2: child gets 1st 404 (kept alive); root gets 304 (skipped)
        try await verifyIncrementalAndTombstone(transport: transport, adapter: adapter, client: client, store: store)
    }

    private func verifyIncrementalAndTombstone(
        transport: MapTransport,
        adapter: any SourceAdapter,
        client: UpstreamHTTPClient,
        store: CorpusStore
    ) async throws {
        transport.setRoute(
            "https://developer.apple.com/tutorials/data/documentation/swiftui/navigationstack.json",
            response: UpstreamFetchResponse(statusCode: 304)
        )
        transport.setRoute(
            "https://developer.apple.com/tutorials/data/documentation/swiftui/navigationpath.json",
            response: UpstreamFetchResponse(statusCode: 404)
        )
        try store.connection.execute("UPDATE crawl_state SET status = 'pending'")
        let run2 = try await SyncOrchestrator.sync(
            adapter: adapter,
            seeds: [],
            client: client,
            into: store,
            options: SyncOrchestrator.Options(maxPages: 10, maxDepth: 1, tombstoneThreshold: 2)
        )
        #expect(run2.skippedNotModified == 1)
        #expect(run2.tombstoned == 0)
        #expect(try store.documentCount() == 2)

        // Run 3: child gets 2nd consecutive 404 -> tombstoned
        try store.connection.execute("UPDATE crawl_state SET status = 'pending' WHERE path = 'swiftui/navigationpath'")
        let run3 = try await SyncOrchestrator.sync(
            adapter: adapter,
            seeds: [],
            client: client,
            into: store,
            options: SyncOrchestrator.Options(maxPages: 10, maxDepth: 1, tombstoneThreshold: 2)
        )
        #expect(run3.tombstoned == 1)
        #expect(try store.documentCount() == 1)
    }
}

private final class MockTransport: UpstreamHTTPTransport {
    private let queue: Mutex<[UpstreamFetchResponse]>

    init(responses: [UpstreamFetchResponse]) {
        self.queue = Mutex(responses)
    }

    func fetch(_ request: UpstreamFetchRequest) async throws(SourceError) -> UpstreamFetchResponse {
        queue.withLock { items in
            items.isEmpty ? UpstreamFetchResponse(statusCode: 500) : items.removeFirst()
        }
    }
}

private final class MapTransport: UpstreamHTTPTransport {
    private let routes: Mutex<[String: UpstreamFetchResponse]>

    init(routes: [String: UpstreamFetchResponse]) {
        self.routes = Mutex(routes)
    }

    func setRoute(_ url: String, response: UpstreamFetchResponse) {
        routes.withLock { $0[url] = response }
    }

    func fetch(_ request: UpstreamFetchRequest) async throws(SourceError) -> UpstreamFetchResponse {
        routes.withLock { $0[request.url] ?? UpstreamFetchResponse(statusCode: 404) }
    }
}
