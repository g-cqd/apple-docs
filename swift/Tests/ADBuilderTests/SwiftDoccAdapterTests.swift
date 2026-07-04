// SwiftDoccAdapter gate: the normalize/extractReferences OUTPUT is pinned from the real JS
// SwiftDoccAdapter (URL + key overrides applied) in Fixtures/SwiftDocc/cases.json; discover is
// exercised over a stub index.json; the pure key/path helpers are unit-checked.

import Foundation
import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("SwiftDoccAdapter — DocC archives with URL/key overrides")
struct SwiftDoccAdapterTests {
    struct Case: Decodable, Sendable {
        let name: String
        let key: String
        let input: String
        let expected: NormalizedPage
        let expectedReferences: [String]
    }

    static let cases: [Case] = {
        guard let base = Bundle.module.url(forResource: "Fixtures", withExtension: nil) else {
            fatalError("ADBuilderTests: Fixtures/ resource directory not bundled")
        }
        let url = base.appendingPathComponent("SwiftDocc/cases.json")
        guard let data = try? Data(contentsOf: url) else {
            fatalError("ADBuilderTests: SwiftDocc/cases.json missing")
        }
        do {
            return try JSONDecoder().decode([Case].self, from: data)
        } catch {
            fatalError("ADBuilderTests: SwiftDocc cases.json decode failed: \(error)")
        }
    }()

    @Test("normalize + extractReferences match the JS SwiftDoccAdapter oracle")
    func parity() throws {
        #expect(!Self.cases.isEmpty)
        let adapter = SwiftDoccAdapter()
        for testCase in Self.cases {
            let payload = SourcePayload.json(Array(testCase.input.utf8))
            let page = try adapter.normalize(testCase.key, payload)
            #expect(page.document == testCase.expected.document, "\(testCase.name) document")
            #expect(page.sections == testCase.expected.sections, "\(testCase.name) sections")
            #expect(page.relationships == testCase.expected.relationships, "\(testCase.name) relationships")
            #expect(
                adapter.extractReferences(testCase.key, payload) == testCase.expectedReferences,
                "\(testCase.name) references")
        }
    }

    // MARK: - pure key/path helpers

    @Test("pathToKey lowercases + scopes to the slug")
    func pathToKey() {
        #expect(
            SwiftDoccAdapter.pathToKey("swift-compiler", "/documentation/Diagnostics/Foo")
                == "swift-compiler/documentation/diagnostics/foo")
        #expect(
            SwiftDoccAdapter.pathToKey("swift-package-manager", "documentation/PackageManagerDocs")
                == "swift-package-manager/documentation/packagemanagerdocs")
    }

    @Test("keyToPath strips the slug prefix, nil for a foreign key")
    func keyToPath() {
        #expect(
            SwiftDoccAdapter.keyToPath("swift-compiler", "swift-compiler/documentation/diagnostics")
                == "/documentation/diagnostics")
        #expect(SwiftDoccAdapter.keyToPath("swift-compiler", "swift-package-manager/x") == nil)
    }

    @Test("addArchivePrefix restores the documentation scope, idempotent")
    func addArchivePrefix() {
        #expect(
            SwiftDoccAdapter.addArchivePrefix("swift-compiler", "diagnostics/foo")
                == "swift-compiler/documentation/diagnostics/foo")
        // Already scoped → unchanged; empty → unchanged.
        #expect(
            SwiftDoccAdapter.addArchivePrefix("swift-compiler", "swift-compiler/documentation/x")
                == "swift-compiler/documentation/x")
        #expect(SwiftDoccAdapter.addArchivePrefix("swift-compiler", "") == "")
    }

    @Test("archiveAndPath throws on an unknown slug")
    func archiveAndPathUnknownSlug() {
        #expect(throws: AdapterError.self) {
            _ = try SwiftDoccAdapter.archiveAndPath(forKey: "not-an-archive/documentation/x")
        }
    }

    // The index.json shape (`interfaceLanguages.swift` tree) `discover` walks via `collectIndexPaths`.
    private static let indexJSON = """
        {"interfaceLanguages":{"swift":[{"path":"/documentation/diagnostics","children":[\
        {"path":"/documentation/diagnostics/actorisolatedcall"}]}]}}
        """

    // MARK: - discover over a stub index.json

    @Test("discover enumerates each archive index into scoped keys + roots")
    func discoverOverStub() async throws {
        let context = SourceContext(
            client: StubHTTPClient { request in
                let url = request.head.url?.absoluteString ?? ""
                if url == "https://docs.swift.org/compiler/index/index.json" {
                    return httpResponse(200, body: Self.indexJSON)
                }
                // The other two archives return an empty index (no swift pages).
                return httpResponse(200, body: "{\"interfaceLanguages\":{\"swift\":[]}}")
            }, rateLimiter: instantRateLimiter())
        let discovery = try await SwiftDoccAdapter().discover(context)
        #expect(
            discovery.keys == [
                "swift-compiler/documentation/diagnostics",
                "swift-compiler/documentation/diagnostics/actorisolatedcall"
            ])
        #expect(discovery.roots.map(\.slug) == ["swift-compiler", "swift-package-manager", "swift-migration-guide"])
        #expect(discovery.roots.allSatisfy { $0.source == "swift-docc" })
    }
}
