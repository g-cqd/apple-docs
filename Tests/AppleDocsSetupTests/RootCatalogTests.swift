import AppleDocsCore
import AppleDocsSources
import AppleDocsStorage
import Testing

@Suite("Root catalog discovery (Bun pipeline/discover.js discoverRoots)")
struct RootCatalogTests {
    static let technologies = #"""
        {"sections":[{"kind":"technologies","groups":[
         {"name":"App Frameworks","technologies":[
          {"title":"SwiftUI","destination":{"identifier":"doc://com.apple.documentation/documentation/SwiftUI"}},
          {"title":"UIKit","destination":{"identifier":"doc://com.apple.documentation/documentation/UIKit"}}]},
         {"name":"Developer Tools","technologies":[
          {"title":"Xcode","destination":{"identifier":"doc://com.apple.documentation/documentation/Xcode"}},
          {"title":"Swift UI Again","destination":{"identifier":"doc://com.apple.documentation/documentation/SwiftUI"}}]},
         {"name":"Sample Code","technologies":[
          {"title":"Sample Apps","destination":{"identifier":"doc://com.apple.documentation/documentation/SampleCode"}}]},
         {"name":"Brand New Group","technologies":[
          {"title":"UIKit Renamed","destination":{"identifier":"doc://com.apple.documentation/documentation/UIKit"}},
          {"title":"No Destination"},
          {"title":"External","destination":{"identifier":"https://example.com/x"}}]}
        ]}]}
        """#

    /// Expected rows produced by Bun's `discoverRoots` over the same JSON (in upsert order).
    @Test func `parses catalog entries in Bun's order with Bun's kinds and source types`() throws {
        let roots = try AppleRootCatalog.roots(fromTechnologies: Array(Self.technologies.utf8))
        let expected = [
            CorpusRootRecord(slug: "swiftui", displayName: "SwiftUI", kind: "framework"),
            CorpusRootRecord(slug: "uikit", displayName: "UIKit", kind: "framework"),
            CorpusRootRecord(slug: "xcode", displayName: "Xcode", kind: "tooling"),
            CorpusRootRecord(slug: "swiftui", displayName: "Swift UI Again", kind: "tooling"),
            CorpusRootRecord(slug: "samplecode", displayName: "Sample Apps", kind: "tutorial"),
            CorpusRootRecord(slug: "uikit", displayName: "UIKit Renamed", kind: "unknown"),
            CorpusRootRecord(
                slug: "design",
                displayName: "Human Interface Guidelines",
                kind: "design",
                sourceType: .hig,
                seedPath: "design/human-interface-guidelines"
            ),
            CorpusRootRecord(
                slug: "app-store-review",
                displayName: "App Store Review Guidelines",
                kind: "guidelines",
                sourceType: .guidelines
            )
        ]
        #expect(roots == expected)
    }

    @Test func `discovered upserts keep crawl state and only override a kind with a known one`() throws {
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        try store.upsertRoot(
            CorpusRootRecord(
                slug: "xcode",
                displayName: "Old",
                kind: "framework",
                seedPath: "xcode/overview",
                pageCount: 42,
                indexETag: "\"abc\""
            )
        )
        for root in try AppleRootCatalog.roots(fromTechnologies: Array(Self.technologies.utf8)) {
            try store.upsertDiscoveredRoot(root)
        }
        let roots = Dictionary(uniqueKeysWithValues: try store.listRoots().map { ($0.slug, $0) })
        #expect(roots.keys.sorted() == ["app-store-review", "design", "samplecode", "swiftui", "uikit", "xcode"])
        #expect(roots["swiftui"]?.displayName == "Swift UI Again" && roots["swiftui"]?.kind == "tooling")
        #expect(roots["uikit"]?.displayName == "UIKit Renamed" && roots["uikit"]?.kind == "framework")
        let xcode = try #require(roots["xcode"])
        #expect(xcode.displayName == "Xcode" && xcode.kind == "tooling")
        #expect(xcode.seedPath == "xcode/overview" && xcode.pageCount == 42 && xcode.indexETag == "\"abc\"")
        #expect(roots["design"]?.seedPath == "design/human-interface-guidelines")
    }

    @Test func `fetches the technologies index from developer.apple.com`() async throws {
        let transport = RecordingTransport()
        transport.set(AppleRootCatalog.technologiesURL, body: Self.technologies)
        let roots = try await AppleRootCatalog.fetch(client: UpstreamHTTPClient(transport: transport))
        #expect(roots.count == 8)
        #expect(
            AppleRootCatalog.technologiesURL
                == "https://developer.apple.com/tutorials/data/documentation/technologies.json"
        )
        transport.remove(AppleRootCatalog.technologiesURL)
        await #expect(throws: SourceError.self) {
            _ = try await AppleRootCatalog.fetch(client: UpstreamHTTPClient(transport: transport))
        }
    }
}
