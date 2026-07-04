// HigAdapterTests — the Human Interface Guidelines crawl adapter (port of
// src/sources/hig.js). discover seeds the single `design` root + landing-page key (no
// network); fetch/check drive the `/tutorials/data/design/…` DocC data URL over a stub
// client; normalize/extractReferences prove the shared DocC delegation emits the `hig`
// source type + `design/` page URL and resolves references to same-root `design/…` keys.

import Foundation
import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("HigAdapter — HIG reference-following crawl source")
struct HigAdapterTests {
    // A minimal HIG DocC page: an abstract for normalize, a topic section (one real
    // `design/` ref + one externally-resolved symbol that must be dropped) for extract.
    private static let higJSON = """
        {
          "metadata": { "title": "Human Interface Guidelines", "role": "collection" },
          "abstract": [{ "type": "text", "text": "Guidance for great app design." }],
          "topicSections": [
            { "title": "Foundations", "identifiers": [
              "doc://com.apple.design/design/human-interface-guidelines/accessibility",
              "doc://com.externally.resolved.symbol/Ghost"
            ]}
          ],
          "references": {
            "doc://com.apple.design/design/human-interface-guidelines/accessibility": {
              "type": "topic",
              "url": "/design/human-interface-guidelines/accessibility",
              "title": "Accessibility",
              "abstract": [{ "type": "text", "text": "Design for everyone." }]
            }
          }
        }
        """

    // MARK: - source metadata

    @Test("source metadata: type, displayName, crawl sync mode")
    func metadata() {
        #expect(HigAdapter.type == "hig")
        #expect(HigAdapter.displayName == "Human Interface Guidelines")
        #expect(HigAdapter.syncMode == .crawl)
    }

    // MARK: - discover (seed + root, no network)

    @Test("discover seeds the single HIG root + its landing-page key")
    func discover() async throws {
        let context = SourceContext(
            client: StubHTTPClient { _ in httpResponse(200) }, rateLimiter: instantRateLimiter())
        let result = try await HigAdapter().discover(context)
        #expect(result.keys == ["design/human-interface-guidelines"])
        #expect(result.roots.count == 1)
        let root = try #require(result.roots.first)
        #expect(root.slug == "design")
        #expect(root.displayName == "Human Interface Guidelines")
        #expect(root.kind == "design")
        #expect(root.source == "hig")
        #expect(root.seedPath == "design/human-interface-guidelines")
    }

    // MARK: - URL scheme (resolveUrl)

    @Test("dataUrl routes design/ keys to the base and others through /documentation/")
    func dataUrl() {
        #expect(
            HigAdapter.dataUrl("design/human-interface-guidelines")
                == "https://developer.apple.com/tutorials/data/design/human-interface-guidelines.json")
        #expect(
            HigAdapter.dataUrl("design/human-interface-guidelines/accessibility")
                == "https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json")
        #expect(
            HigAdapter.dataUrl("swiftui/view")
                == "https://developer.apple.com/tutorials/data/documentation/swiftui/view.json")
    }

    // MARK: - fetch

    @Test("fetch GETs the design data URL and returns a json payload with validators")
    func fetch() async throws {
        let json = "{\"metadata\":{\"title\":\"HIG\"}}"
        let client = StubHTTPClient { _ in
            httpResponse(
                200, body: json,
                headerFields: [.eTag: "\"hig-etag\"", .lastModified: "Wed, 01 Jan 2025 00:00:00 GMT"])
        }
        let context = SourceContext(client: client, rateLimiter: instantRateLimiter())
        let result = try await HigAdapter().fetch("design/human-interface-guidelines", context)
        guard case .json(let bytes) = result.payload else {
            Issue.record("expected a json payload")
            return
        }
        #expect(String(decoding: bytes, as: UTF8.self) == json)
        #expect(result.etag == "\"hig-etag\"")
        #expect(result.lastModified == "Wed, 01 Jan 2025 00:00:00 GMT")
        #expect(
            client.requests.first?.head.url?.absoluteString
                == "https://developer.apple.com/tutorials/data/design/human-interface-guidelines.json")
    }

    // MARK: - check (conditional HEAD)

    @Test("check maps 304/200/404 to unchanged/modified/deleted")
    func check() async throws {
        let key = "design/human-interface-guidelines"

        let unchanged = SourceContext(
            client: StubHTTPClient { _ in httpResponse(304) }, rateLimiter: instantRateLimiter())
        let r1 = try await HigAdapter().check(key, previousState: "\"e\"", unchanged)
        #expect(r1.status == .unchanged)
        #expect(r1.changed == false)
        #expect(r1.newState == "\"e\"")

        let modified = SourceContext(
            client: StubHTTPClient { _ in httpResponse(200, headerFields: [.eTag: "\"new\""]) },
            rateLimiter: instantRateLimiter())
        let r2 = try await HigAdapter().check(key, previousState: "\"e\"", modified)
        #expect(r2.status == .modified)
        #expect(r2.changed == true)
        #expect(r2.newState == "\"new\"")

        let deleted = SourceContext(
            client: StubHTTPClient { _ in httpResponse(404) }, rateLimiter: instantRateLimiter())
        let r3 = try await HigAdapter().check(key, previousState: nil, deleted)
        #expect(r3.status == .deleted)
        #expect(r3.deleted == true)
    }

    // MARK: - normalize (shared DocC normalizer, hig overrides via source type)

    @Test("normalize delegates to the DocC normalizer with the hig source type + design URL")
    func normalize() throws {
        let page = try HigAdapter()
            .normalize(
                "design/human-interface-guidelines", .json(Array(Self.higJSON.utf8)))
        #expect(page.document.sourceType == "hig")
        #expect(page.document.key == "design/human-interface-guidelines")
        #expect(page.document.title == "Human Interface Guidelines")
        #expect(page.document.framework == "design")
        #expect(page.document.url == "https://developer.apple.com/design/human-interface-guidelines")
        #expect(page.document.abstractText == "Guidance for great app design.")
    }

    @Test("normalize rejects a non-json payload")
    func normalizeRejectsNonJson() {
        #expect(throws: AdapterError.self) {
            _ = try HigAdapter().normalize("design/human-interface-guidelines", .markdown("nope"))
        }
    }

    // MARK: - extractReferences (same-root design keys, external symbols dropped)

    @Test("extractReferences yields same-root design keys, dropping external symbols")
    func extractReferences() {
        let refs = HigAdapter()
            .extractReferences(
                "design/human-interface-guidelines", .json(Array(Self.higJSON.utf8)))
        #expect(refs == ["design/human-interface-guidelines/accessibility"])
    }

    @Test("extractReferences returns [] for a non-json payload")
    func extractReferencesNonJson() {
        #expect(HigAdapter().extractReferences("design/human-interface-guidelines", .html("<x>")).isEmpty)
    }
}
