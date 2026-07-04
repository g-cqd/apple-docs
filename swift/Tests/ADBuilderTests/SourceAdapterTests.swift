// Gate for the crawl source architecture (D3b): the SourceAdapter protocol defaults,
// the registry dispatch, and the NormalizedPage output — verified with a fake adapter,
// fully in-isolation (no network, no ADWrite).

import Testing

@testable import ADBuilder

@Suite("SourceAdapter protocol + registry")
struct SourceAdapterTests {
    /// A canned adapter exercising the protocol surface.
    private struct FakeAdapter: SourceAdapter {
        static let type = "fake"
        static let displayName = "Fake Source"

        func discover(_ context: SourceContext) async throws -> DiscoveryResult {
            DiscoveryResult(
                keys: ["fake/a", "fake/b"],
                roots: [
                    DiscoveredRoot(slug: "fake", displayName: "Fake", kind: "collection", source: "fake")
                ])
        }
        func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
            FetchResult(key: key, payload: .markdown("# Title"), etag: "abc")
        }
        func check(_ key: String, previousState: String?, _ context: SourceContext) async throws -> CheckResult {
            CheckResult(status: .modified, changed: true, newState: "abc")
        }
        func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
            NormalizedPage(
                document: NormalizedDocument(sourceType: Self.type, key: key, title: "Title"),
                sections: [NormalizedSection(sectionKind: "abstract", contentText: "Body", sortOrder: 0)])
        }
    }

    @Test("registry vends a fresh adapter by type; unknown throws")
    func registryDispatch() throws {
        let registry = SourceRegistry([FakeAdapter.self])
        #expect(registry.types == ["fake"])
        let adapter = try registry.adapter(for: "fake")
        #expect(adapter.type == "fake")
        #expect(throws: SourceRegistry.RegistryError.unknownSourceType("nope")) {
            _ = try registry.adapter(for: "nope")
        }
    }

    @Test("protocol defaults: network-on, crawl mode, no entry points, no references")
    func protocolDefaults() {
        #expect(FakeAdapter.requiresNetwork)
        #expect(FakeAdapter.syncMode == .crawl)
        #expect(FakeAdapter.entryPoints.isEmpty)
        #expect(FakeAdapter().extractReferences("fake/a", .markdown("x")).isEmpty)
    }

    @Test("normalize produces a NormalizedPage with document + sections")
    func normalizeShape() throws {
        let page = try FakeAdapter().normalize("fake/a", .markdown("# Title"))
        #expect(page.document.key == "fake/a")
        #expect(page.document.sourceType == "fake")
        #expect(page.document.title == "Title")
        #expect(page.sections.count == 1)
        #expect(page.sections.first?.sectionKind == "abstract")
        #expect(page.relationships.isEmpty)
    }
}
