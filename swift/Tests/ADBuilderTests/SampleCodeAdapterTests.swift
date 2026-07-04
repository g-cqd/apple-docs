// SampleCodeAdapter gate: `discover` yields the hardcoded BOOTSTRAP seed set (scoped under
// the `sample-code/` root) with NO network/storage access; `normalize` reuses the shared
// DocC normalizer and stamps the sample-code overrides; the pure key/path helpers are
// unit-checked. This mirrors the JS SampleCodeAdapter bootstrap path (the DB
// `getPagesByRole('sampleCode')` supplement is out of scope — adapters are storage-free).

import Foundation
import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("SampleCodeAdapter — DocC sample projects, bootstrap seed set")
struct SampleCodeAdapterTests {

    // MARK: - static metadata

    @Test("type / displayName / syncMode mirror the JS statics")
    func statics() {
        #expect(SampleCodeAdapter.type == "sample-code")
        #expect(SampleCodeAdapter.displayName == "Apple Sample Code")
        #expect(SampleCodeAdapter.syncMode == .flat)
    }

    // MARK: - discover (bootstrap, offline)

    @Test("discover returns the bootstrap seed set scoped under the sample-code root, no network")
    func discoverBootstrap() async throws {
        // A handler that would flag any accidental network use during the bootstrap path.
        let client = StubHTTPClient { _ in httpResponse(500) }
        let context = SourceContext(client: client, rateLimiter: instantRateLimiter())

        let discovery = try await SampleCodeAdapter().discover(context)

        // Bootstrap discovery is pure — it must not touch the transport.
        #expect(client.requests.isEmpty)

        // 86 curated paths, each scoped under `sample-code/`, in list order, deduplicated.
        #expect(discovery.keys.count == 86)
        #expect(Set(discovery.keys).count == discovery.keys.count)
        #expect(discovery.keys.allSatisfy { $0.hasPrefix("sample-code/") })
        #expect(discovery.keys.first == "sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app")
        #expect(discovery.keys.last == "sample-code/combine/using-combine-for-your-app-s-asynchronous-code")
        #expect(discovery.keys.contains("sample-code/visionos/bot-anist"))

        // A single `collection` root, source == the adapter type (JS ROOT_SLUG).
        #expect(
            discovery.roots == [
                DiscoveredRoot(
                    slug: "sample-code", displayName: "Apple Sample Code", kind: "collection",
                    source: "sample-code")
            ])
    }

    // MARK: - normalize (shared DocC normalizer + sample-code overrides)

    /// A minimal DocC JSON page (the shared normalizer's own parity is covered elsewhere;
    /// here we only assert the sample-code field OVERRIDES).
    private static let sampleDocC = """
        {"metadata":{"title":"Food Truck","role":"sampleCode"},\
        "abstract":[{"type":"text","text":"Build a SwiftUI multiplatform app."}]}
        """

    @Test("normalize stamps sample-code sourceType/kind/framework/url/sourceMetadata")
    func normalizeOverrides() throws {
        let key = "sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app"
        let page = try SampleCodeAdapter().normalize(key, .json(Array(Self.sampleDocC.utf8)))

        let doc = page.document
        #expect(doc.key == key)  // key is NOT rewritten
        #expect(doc.title == "Food Truck")  // preserved from the shared normalizer
        #expect(doc.sourceType == "sample-code")
        #expect(doc.kind == "sample-project")
        #expect(doc.framework == "swiftui")
        #expect(
            doc.url
                == "https://developer.apple.com/documentation/swiftui/food-truck-building-a-swiftui-multiplatform-app")
        #expect(doc.sourceMetadata == #"{"sampleProject":true,"frameworks":["swiftui"]}"#)
    }

    @Test("normalize rejects a non-json payload")
    func normalizeWrongPayload() {
        #expect(throws: AdapterError.self) {
            _ = try SampleCodeAdapter().normalize("sample-code/swiftui/x", .html("<html></html>"))
        }
    }

    // MARK: - pure key/path helpers

    @Test("stripRootPrefix recovers the developer.apple.com doc path")
    func stripRootPrefix() {
        #expect(
            SampleCodeAdapter.stripRootPrefix("sample-code/swiftui/food-truck")
                == "swiftui/food-truck")
        // No `sample-code/` prefix → unchanged.
        #expect(SampleCodeAdapter.stripRootPrefix("swiftui/food-truck") == "swiftui/food-truck")
    }

    @Test("framework is the leading doc-path segment")
    func framework() {
        #expect(SampleCodeAdapter.framework(forDocPath: "swiftui/food-truck") == "swiftui")
        #expect(SampleCodeAdapter.framework(forDocPath: "visionos/world") == "visionos")
        // Empty doc path → "" (JS `''.split('/')[0]`), never nil.
        #expect(SampleCodeAdapter.framework(forDocPath: "") == "")
    }

    @Test("resolveURL maps doc paths onto the tutorials data API (design branch ported)")
    func resolveURL() {
        #expect(
            SampleCodeAdapter.resolveURL("swiftui/view")
                == "https://developer.apple.com/tutorials/data/documentation/swiftui/view.json")
        #expect(
            SampleCodeAdapter.resolveURL("design/human-interface-guidelines/accessibility")
                == "https://developer.apple.com/tutorials/data/design/human-interface-guidelines/accessibility.json")
    }

    @Test("sampleSourceMetadata mirrors JSON.stringify with JS falsy-framework handling")
    func sampleSourceMetadata() {
        #expect(
            SampleCodeAdapter.sampleSourceMetadata("swiftui")
                == #"{"sampleProject":true,"frameworks":["swiftui"]}"#)
        // Empty / nil framework is falsy in JS ⇒ an empty frameworks array.
        #expect(
            SampleCodeAdapter.sampleSourceMetadata("")
                == #"{"sampleProject":true,"frameworks":[]}"#)
        #expect(
            SampleCodeAdapter.sampleSourceMetadata(nil)
                == #"{"sampleProject":true,"frameworks":[]}"#)
    }
}
