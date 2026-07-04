// AppleDoccAdapterTests — the dominant developer.apple.com DocC crawl adapter (port of
// src/sources/apple-docc.js + the `discoverRoots` half of src/pipeline/discover.js). discover
// builds EVERY DocC root from a stub technologies index (sections → groups → technologies through
// KIND_MAP + normalizeIdentifier + extractRootSlug, deduped by slug, with HIG's https:// destination
// rejected so `design` is NOT emitted); fetch/check drive the `/tutorials/data/documentation/…` DocC
// data URL over a stub client; normalize/extractReferences prove the shared DocC delegation emits the
// `apple-docc` source type + `developer.apple.com/documentation/…` page URL and resolves references
// to same-root storage keys.

import Foundation
import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("AppleDoccAdapter — developer.apple.com DocC reference-following crawl source")
struct AppleDoccAdapterTests {
    // A stub technologies index: two framework groups (with a duplicate SwiftUI to exercise the
    // slug dedupe), a tooling group, and a Design group whose HIG destination is an https:// URL
    // that normalizeIdentifier rejects (so `design` is never emitted — that's the hig adapter's root).
    private static let technologiesJSON = """
        {
          "sections": [
            {
              "kind": "technologies",
              "groups": [
                { "name": "App Frameworks", "technologies": [
                  { "title": "SwiftUI", "destination": { "identifier": "doc://com.apple.SwiftUI/documentation/SwiftUI" } },
                  { "title": "UIKit", "destination": { "identifier": "/documentation/UIKit" } }
                ]},
                { "name": "App Services", "technologies": [
                  { "title": "SwiftUI Duplicate", "destination": { "identifier": "/documentation/SwiftUI" } },
                  { "title": "Foundation", "destination": { "identifier": "documentation/Foundation" } }
                ]},
                { "name": "Developer Tools", "technologies": [
                  { "title": "Xcode", "destination": { "identifier": "documentation/Xcode" } }
                ]},
                { "name": "Design", "technologies": [
                  { "title": "Human Interface Guidelines", "destination": { "identifier": "https://developer.apple.com/design/human-interface-guidelines" } }
                ]}
              ]
            }
          ]
        }
        """

    // A minimal DocC page: an abstract for normalize, a topic section (one real doc ref + one
    // externally-resolved symbol that must be dropped) for extract.
    private static let pageJSON = """
        {
          "metadata": { "title": "View", "role": "symbol", "roleHeading": "Protocol" },
          "abstract": [{ "type": "text", "text": "A type that represents part of your app's user interface." }],
          "topicSections": [
            { "title": "Creating a View", "identifiers": [
              "doc://com.apple.SwiftUI/documentation/SwiftUI/Text",
              "doc://com.externally.resolved.symbol/s:SQ"
            ]}
          ],
          "references": {
            "doc://com.apple.SwiftUI/documentation/SwiftUI/Text": {
              "type": "topic",
              "url": "/documentation/swiftui/text",
              "title": "Text",
              "abstract": [{ "type": "text", "text": "A view that displays text." }]
            }
          }
        }
        """

    // MARK: - source metadata

    @Test("source metadata: type, displayName, crawl sync mode")
    func metadata() {
        #expect(AppleDoccAdapter.type == "apple-docc")
        #expect(AppleDoccAdapter.displayName == "Apple Developer Documentation")
        #expect(AppleDoccAdapter.syncMode == .crawl)
    }

    // MARK: - discover (technologies index → all DocC roots + per-root seed key)

    /// Runs `discover` against a stub serving the technologies index (404 otherwise); returns the result +
    /// the client for the request assertions. Shared by the split tests below (each stays under the 250 ms
    /// type-check budget — the single-body form with all the `map(\.…) == […]` comparisons tripped it).
    private func discoverResult() async throws -> (result: DiscoveryResult, client: StubHTTPClient) {
        let client = StubHTTPClient { request in
            let url = request.head.url?.absoluteString ?? ""
            if url == "https://developer.apple.com/tutorials/data/documentation/technologies.json" {
                return httpResponse(200, body: Self.technologiesJSON)
            }
            return httpResponse(404)
        }
        let context = SourceContext(client: client, rateLimiter: instantRateLimiter())
        return (try await AppleDoccAdapter().discover(context), client)
    }

    @Test("discover builds DocC roots from the technologies index (KIND_MAP, dedupe, HIG excluded)")
    func discoverRoots() async throws {
        let (result, _) = try await discoverResult()
        // One root per unique slug in first-seen order; group name → kind via KIND_MAP; title from the
        // technology; source = the adapter type. HIG's https:// destination is rejected → no `design`.
        let slugs: [String] = result.roots.map(\.slug)
        let kinds: [String] = result.roots.map(\.kind)
        let displays: [String] = result.roots.map(\.displayName)
        #expect(slugs == ["swiftui", "uikit", "foundation", "xcode"])
        #expect(kinds == ["framework", "framework", "framework", "tooling"])
        #expect(displays == ["SwiftUI", "UIKit", "Foundation", "Xcode"])
        #expect(result.roots.allSatisfy { $0.source == "apple-docc" })
        #expect(!slugs.contains("design"))
    }

    @Test("discover seeds each root at its slug + hits only the technologies index")
    func discoverKeysAndRequest() async throws {
        let (result, client) = try await discoverResult()
        // Each root is seeded at its slug (the JS `keys: roots.map(root => root.slug)`).
        let keys: [String] = result.keys
        #expect(keys == ["swiftui", "uikit", "foundation", "xcode"])
        // Exactly one request, to the technologies index.
        let urls: [String] = client.requests.compactMap { $0.head.url?.absoluteString }
        #expect(urls == ["https://developer.apple.com/tutorials/data/documentation/technologies.json"])
    }

    @Test("discover throws when the technologies index is unavailable")
    func discoverIndexFailure() async {
        let context = SourceContext(
            client: StubHTTPClient { _ in httpResponse(404) }, rateLimiter: instantRateLimiter())
        await #expect(throws: AdapterError.self) {
            _ = try await AppleDoccAdapter().discover(context)
        }
    }

    // MARK: - URL scheme (resolveUrl) + pure helpers

    @Test("dataUrl routes documentation keys through /documentation/ and design/ keys to the base")
    func dataUrl() {
        #expect(
            AppleDoccAdapter.dataUrl("swiftui/view")
                == "https://developer.apple.com/tutorials/data/documentation/swiftui/view.json")
        #expect(
            AppleDoccAdapter.dataUrl("uikit")
                == "https://developer.apple.com/tutorials/data/documentation/uikit.json")
        #expect(
            AppleDoccAdapter.dataUrl("design/human-interface-guidelines")
                == "https://developer.apple.com/tutorials/data/design/human-interface-guidelines.json")
    }

    @Test("technologiesUrl is the tutorials-data technologies index")
    func technologiesUrl() {
        #expect(
            AppleDoccAdapter.technologiesUrl
                == "https://developer.apple.com/tutorials/data/documentation/technologies.json")
    }

    @Test("extractRootSlug is the leading path segment")
    func extractRootSlug() {
        #expect(AppleDoccAdapter.extractRootSlug("swiftui/view/body-swift.property") == "swiftui")
        #expect(AppleDoccAdapter.extractRootSlug("uikit") == "uikit")
    }

    // MARK: - fetch

    @Test("fetch GETs the documentation data URL and returns a json payload with validators")
    func fetch() async throws {
        let json = "{\"metadata\":{\"title\":\"View\"}}"
        let client = StubHTTPClient { _ in
            httpResponse(
                200, body: json,
                headerFields: [.eTag: "\"v-etag\"", .lastModified: "Wed, 01 Jan 2025 00:00:00 GMT"])
        }
        let context = SourceContext(client: client, rateLimiter: instantRateLimiter())
        let result = try await AppleDoccAdapter().fetch("swiftui/view", context)
        guard case .json(let bytes) = result.payload else {
            Issue.record("expected a json payload")
            return
        }
        #expect(String(decoding: bytes, as: UTF8.self) == json)
        #expect(result.etag == "\"v-etag\"")
        #expect(result.lastModified == "Wed, 01 Jan 2025 00:00:00 GMT")
        #expect(
            client.requests.first?.head.url?.absoluteString
                == "https://developer.apple.com/tutorials/data/documentation/swiftui/view.json")
    }

    // MARK: - check (conditional HEAD)

    @Test("check maps 304/200/404 to unchanged/modified/deleted")
    func check() async throws {
        let key = "swiftui/view"

        let unchanged = SourceContext(
            client: StubHTTPClient { _ in httpResponse(304) }, rateLimiter: instantRateLimiter())
        let r1 = try await AppleDoccAdapter().check(key, previousState: "\"e\"", unchanged)
        #expect(r1.status == .unchanged)
        #expect(r1.changed == false)
        #expect(r1.newState == "\"e\"")

        let modified = SourceContext(
            client: StubHTTPClient { _ in httpResponse(200, headerFields: [.eTag: "\"new\""]) },
            rateLimiter: instantRateLimiter())
        let r2 = try await AppleDoccAdapter().check(key, previousState: "\"e\"", modified)
        #expect(r2.status == .modified)
        #expect(r2.changed == true)
        #expect(r2.newState == "\"new\"")

        let deleted = SourceContext(
            client: StubHTTPClient { _ in httpResponse(404) }, rateLimiter: instantRateLimiter())
        let r3 = try await AppleDoccAdapter().check(key, previousState: nil, deleted)
        #expect(r3.status == .deleted)
        #expect(r3.deleted == true)
    }

    // MARK: - normalize (shared DocC normalizer, apple-docc source type + developer.apple.com URL)

    @Test("normalize delegates to the DocC normalizer with the apple-docc source type + doc URL")
    func normalize() throws {
        let page = try AppleDoccAdapter().normalize("swiftui/view", .json(Array(Self.pageJSON.utf8)))
        #expect(page.document.sourceType == "apple-docc")
        #expect(page.document.key == "swiftui/view")
        #expect(page.document.title == "View")
        #expect(page.document.framework == "swiftui")
        #expect(page.document.url == "https://developer.apple.com/documentation/swiftui/view")
        #expect(
            page.document.abstractText == "A type that represents part of your app's user interface.")
    }

    @Test("normalize rejects a non-json payload")
    func normalizeRejectsNonJson() {
        #expect(throws: AdapterError.self) {
            _ = try AppleDoccAdapter().normalize("swiftui/view", .markdown("nope"))
        }
    }

    // MARK: - extractReferences (same-root doc keys, external symbols dropped)

    @Test("extractReferences yields resolved documentation keys, dropping external symbols")
    func extractReferences() {
        let refs = AppleDoccAdapter()
            .extractReferences(
                "swiftui/view", .json(Array(Self.pageJSON.utf8)))
        #expect(refs == ["swiftui/text"])
    }

    @Test("extractReferences returns [] for a non-json payload")
    func extractReferencesNonJson() {
        #expect(AppleDoccAdapter().extractReferences("swiftui/view", .html("<x>")).isEmpty)
    }
}
