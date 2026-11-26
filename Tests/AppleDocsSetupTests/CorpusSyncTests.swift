import AppleDocsCore
import AppleDocsPipeline
import AppleDocsSources
import AppleDocsStorage
import Foundation
import Testing

/// Corpus-scale sync (Bun `commands/sync.js` + `update/docc.js`): catalog roots, per-root index gating, and one
/// breadth-first crawl across every selected root.
@Suite("Corpus sync: catalog, index gate, multi-root crawl")
struct CorpusSyncTests {
    private static let catalog = #"""
        {"sections":[{"kind":"technologies","groups":[{"name":"App Frameworks","technologies":[
          {"title":"SwiftUI","destination":{"identifier":"doc://com.apple.documentation/documentation/SwiftUI"}},
          {"title":"UIKit","destination":{"identifier":"doc://com.apple.documentation/documentation/UIKit"}}]}]}]}
        """#

    private static func page(_ title: String, links: [String] = []) -> String {
        let identifiers = links.map { "\"doc://a/documentation/\($0)\"" }.joined(separator: ",")
        let references = links.map { "\"doc://a/documentation/\($0)\": {\"url\": \"/documentation/\($0)\"}" }
            .joined(separator: ",")
        return """
            {"metadata": {"title": "\(title)"},
             "topicSections": [{"title": "Topics", "identifiers": [\(identifiers)]}],
             "references": {\(references)}}
            """
    }

    private static func index(_ slug: String, _ keys: [String]) -> String {
        let children = keys.map { "{\"path\": \"/documentation/\($0)\", \"title\": \"\($0)\"}" }.joined(separator: ",")
        return #"{"interfaceLanguages": {"swift": [{"path": "/documentation/\#(slug)", "children": [\#(children)]}]}}"#
    }

    private static func pageURL(_ key: String) -> String {
        "https://developer.apple.com/tutorials/data/documentation/\(key).json"
    }

    private func makeUpstream() -> RecordingTransport {
        let transport = RecordingTransport()
        transport.set(AppleRootCatalog.technologiesURL, body: Self.catalog)
        transport.set(Self.pageURL("swiftui"), body: Self.page("SwiftUI", links: ["swiftui/view"]), etag: "\"p1\"")
        transport.set(Self.pageURL("swiftui/view"), body: Self.page("View"), etag: "\"p2\"")
        transport.set(Self.pageURL("uikit"), body: Self.page("UIKit"), etag: "\"p3\"")
        transport.set(
            DocCRootIndex.url(forRoot: "swiftui"),
            body: Self.index("swiftui", ["swiftui/view"]),
            etag: "\"i1\""
        )
        transport.set(DocCRootIndex.url(forRoot: "uikit"), body: Self.index("uikit", []), etag: "\"u1\"")
        return transport
    }

    private func pageRequests(_ transport: RecordingTransport) -> [String] {
        transport.requests.map(\.url)
            .filter { $0.contains("/tutorials/data/documentation/") && !$0.hasSuffix("technologies.json") }
            .map {
                $0.replacing("https://developer.apple.com/tutorials/data/documentation/", with: "")
                    .replacing(".json", with: "")
            }
            .sorted()
    }

    @Test func `first run discovers the catalog roots and crawls every Apple DocC root`() async throws {
        let transport = makeUpstream()
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let report = try await CorpusSync.run(
            client: UpstreamHTTPClient(transport: transport),
            store: store,
            options: CorpusSync.Options(sources: [.appleDocC], concurrency: 4)
        )
        #expect(report.rootsDiscovered == 4)  // swiftui, uikit, design, app-store-review
        #expect(report.rootsSelected == 2)
        #expect(report.fullSweep)
        #expect(report.crawl.fetchedModified == 3 && report.crawl.errors == 0)
        #expect(try store.documentCount() == 3)
        let roots = Dictionary(uniqueKeysWithValues: try store.listRoots().map { ($0.slug, $0) })
        #expect(roots["swiftui"]?.indexETag == "\"i1\"" && roots["uikit"]?.indexETag == "\"u1\"")
        #expect(roots["swiftui"]?.pageCount == 2 && roots["swiftui"]?.displayName == "SwiftUI")
    }

    @Test func `an unchanged index skips its root, a changed one rechecks only that root`() async throws {
        let transport = makeUpstream()
        let client = UpstreamHTTPClient(transport: transport)
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let options = CorpusSync.Options(sources: [.appleDocC], concurrency: 4)
        _ = try await CorpusSync.run(client: client, store: store, options: options)

        transport.resetLog()
        let quiet = try await CorpusSync.run(client: client, store: store, options: options)
        #expect(!quiet.fullSweep)
        #expect(quiet.rootsUnchanged == 2)
        #expect(pageRequests(transport).isEmpty)
        #expect(
            transport.requests.filter { $0.url.contains("/tutorials/data/index/") }.allSatisfy { $0.ifNoneMatch != nil }
        )

        transport.set(DocCRootIndex.url(forRoot: "uikit"), body: Self.index("uikit", ["uikit/uiview"]), etag: "\"u2\"")
        transport.set(Self.pageURL("uikit/uiview"), body: Self.page("UIView"), etag: "\"p4\"")
        transport.resetLog()
        let changed = try await CorpusSync.run(client: client, store: store, options: options)
        #expect(changed.rootsUnchanged == 1)
        #expect(changed.pagesSeededFromIndex == 1)
        #expect(pageRequests(transport) == ["uikit", "uikit/uiview"])
        #expect(changed.crawl.fetchedModified == 1 && changed.crawl.skippedNotModified == 1)
        #expect(transport.requests.first { $0.url == Self.pageURL("uikit") }?.ifNoneMatch == "\"p3\"")
        #expect(try store.listRoots().first { $0.slug == "uikit" }?.indexETag == "\"u2\"")
        #expect(try store.documentCount() == 4)
    }

    @Test func `a full run revalidates every page conditionally`() async throws {
        let transport = makeUpstream()
        let client = UpstreamHTTPClient(transport: transport)
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        _ = try await CorpusSync.run(
            client: client,
            store: store,
            options: CorpusSync.Options(sources: [.appleDocC], concurrency: 4)
        )
        transport.resetLog()
        let full = try await CorpusSync.run(
            client: client,
            store: store,
            options: CorpusSync.Options(sources: [.appleDocC], full: true, concurrency: 4)
        )
        #expect(full.fullSweep)
        #expect(pageRequests(transport) == ["swiftui", "swiftui/view", "uikit"])
        #expect(full.crawl.skippedNotModified == 3 && full.crawl.fetchedModified == 0)
    }

    @Test func `a run stopped by the page budget keeps the index ETag uncommitted`() async throws {
        let transport = makeUpstream()
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let report = try await CorpusSync.run(
            client: UpstreamHTTPClient(transport: transport),
            store: store,
            options: CorpusSync.Options(sources: [.appleDocC], roots: ["swiftui"], concurrency: 1, maxPages: 1)
        )
        #expect(report.rootsSelected == 1 && report.crawl.fetchedModified == 1)
        // swiftui/view is still pending, so the next run must not trust the index.
        #expect(try store.listRoots().first { $0.slug == "swiftui" }?.indexETag == nil)
    }

    /// A root whose index request fails is revalidated page by page while the other roots still use their gates.
    /// Regression: Swift 6.4 release builds dropped the other task-group results when one child's
    /// `return (slug, .success(try await fetch()))` threw (see docs/verification.md, "Compiler issues").
    @Test func `an index failure only affects its own root`() async throws {
        let transport = makeUpstream()
        let client = UpstreamHTTPClient(transport: transport)
        let store = try CorpusStore(path: ":memory:")
        defer { store.close() }
        let options = CorpusSync.Options(sources: [.appleDocC], concurrency: 4)
        _ = try await CorpusSync.run(client: client, store: store, options: options)

        transport.fail(DocCRootIndex.url(forRoot: "uikit"), status: 500)
        transport.resetLog()
        let report = try await CorpusSync.run(client: client, store: store, options: options)
        #expect(report.indexFailures.keys.sorted() == ["uikit"])
        #expect(report.rootsUnchanged == 1)
        #expect(pageRequests(transport) == ["uikit"])
        #expect(report.crawl.skippedNotModified == 1)
    }
}
