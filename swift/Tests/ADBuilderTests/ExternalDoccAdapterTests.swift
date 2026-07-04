// ExternalDoccAdapter gate: the pure URL/key helpers (parseDoccArchiveUrl / indexPathToKey /
// extractRootSlug) are unit-checked; `discover` is exercised over a stub — technologies.json
// detection (structural reject + a live-probe accept AND a non-DocC probe reject) then per-archive
// index enumeration; the internal `enumerateBfs` fallback is driven over a stub; and
// normalize/extractReferences are pinned on an inline CareKit DocC payload (URL points upstream,
// refs re-scoped to the archive slug).

import Foundation
import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("ExternalDoccAdapter — external DocC archives (curated + probe-detected)")
struct ExternalDoccAdapterTests {
    // MARK: - parseDoccArchiveUrl (docc-url shape recognition)

    @Test("parseDoccArchiveUrl recognises the CareKit GitHub Pages project site")
    func parsesProjectSite() {
        let parsed = ExternalDoccAdapter.parseDoccArchiveUrl(
            "https://carekit-apple.github.io/CareKit/documentation/CareKit/OCKTask")
        #expect(parsed?.slug == "carekit")
        // Prefix case is preserved (GitHub Pages is case-sensitive); slug/entryKey are lowercased.
        #expect(parsed?.baseUrl == "https://carekit-apple.github.io/CareKit")
        #expect(parsed?.entryKey == "carekit/ocktask")
    }

    @Test("parseDoccArchiveUrl recognises a root-hosted archive (empty prefix)")
    func parsesRootHosted() {
        let parsed = ExternalDoccAdapter.parseDoccArchiveUrl(
            "https://security.apple.com/documentation/private-cloud-compute")
        #expect(parsed?.slug == "private-cloud-compute")
        #expect(parsed?.baseUrl == "https://security.apple.com")
        #expect(parsed?.entryKey == "private-cloud-compute")
    }

    @Test("parseDoccArchiveUrl rejects non-DocC / apple-corpus / non-https / operator segments")
    func parseRejects() {
        // No /documentation/ path (github.com/ResearchKit, the MusicKit JS landing page).
        #expect(ExternalDoccAdapter.parseDoccArchiveUrl("https://github.com/ResearchKit/ResearchKit") == nil)
        // developer.apple.com is the primary corpus (apple-docc adapter), never external.
        #expect(ExternalDoccAdapter.parseDoccArchiveUrl("https://developer.apple.com/documentation/swiftui") == nil)
        #expect(
            ExternalDoccAdapter.parseDoccArchiveUrl("https://beta.developer.apple.com/documentation/swiftui") == nil)
        // Not https (http://, doc://, a bare identifier).
        #expect(ExternalDoccAdapter.parseDoccArchiveUrl("http://security.apple.com/documentation/pcc") == nil)
        #expect(ExternalDoccAdapter.parseDoccArchiveUrl("doc://com.apple.SwiftUI/documentation/swiftui") == nil)
        #expect(ExternalDoccAdapter.parseDoccArchiveUrl("not a url") == nil)
        // A Swift-operator doc segment (starts with '.' + an operator char) is rejected.
        #expect(ExternalDoccAdapter.parseDoccArchiveUrl("https://x.example/documentation/pkg/.-op") == nil)
    }

    // MARK: - indexPathToKey / extractRootSlug (pure)

    @Test("indexPathToKey strips /documentation/, lowercases, drops trailing slashes")
    func indexPathToKey() {
        #expect(ExternalDoccAdapter.indexPathToKey("/documentation/carekit/octask") == "carekit/octask")
        // Case-insensitive prefix; the returned key is lowercased.
        #expect(ExternalDoccAdapter.indexPathToKey("/DOCUMENTATION/CareKit") == "carekit")
        #expect(ExternalDoccAdapter.indexPathToKey("/documentation/carekit/") == "carekit")
        // Not a /documentation/ path, or nothing after the prefix → nil.
        #expect(ExternalDoccAdapter.indexPathToKey("/tutorials/carekit") == nil)
        #expect(ExternalDoccAdapter.indexPathToKey("/documentation/") == nil)
    }

    @Test("extractRootSlug is the first path segment")
    func extractRootSlug() {
        #expect(ExternalDoccAdapter.extractRootSlug("carekit/octask") == "carekit")
        #expect(ExternalDoccAdapter.extractRootSlug("carekit") == "carekit")
        #expect(ExternalDoccAdapter.extractRootSlug("") == "")
    }

    @Test("resolveArchive resolves a curated slug, throws on an unknown one")
    func resolveArchive() throws {
        let adapter = ExternalDoccAdapter()
        let (slug, archive) = try adapter.resolveArchive("carekit/octask")
        #expect(slug == "carekit")
        #expect(archive.baseUrl == "https://carekit-apple.github.io/CareKit")
        #expect(throws: AdapterError.self) { _ = try adapter.resolveArchive("not-an-archive/x") }
    }

    // MARK: - normalize + extractReferences (shared DocC normalizer + archive URL override)

    // A CareKit DocC page: the URL must point at the upstream GitHub Pages host, and refs must be
    // filtered to the archive slug (the cross-module `foundation/date` link is dropped).
    private static let careKitPage = """
        {"schemaVersion":{"major":0,"minor":3,"patch":0},\
        "identifier":{"url":"doc://carekit/documentation/carekit/octask"},"kind":"symbol",\
        "metadata":{"title":"OCKTask","role":"symbol"},\
        "abstract":[{"type":"text","text":"A task in a care plan."}],\
        "topicSections":[{"identifiers":[\
        "doc://carekit/documentation/carekit/octask/init",\
        "doc://com.apple.documentation/documentation/foundation/date"]}]}
        """

    @Test("normalize builds the upstream page URL + external-docc sourceType")
    func normalizeCareKit() throws {
        let adapter = ExternalDoccAdapter()
        let page = try adapter.normalize("carekit/octask", .json(Array(Self.careKitPage.utf8)))
        #expect(page.document.sourceType == "external-docc")
        #expect(page.document.key == "carekit/octask")
        #expect(page.document.title == "OCKTask")
        #expect(page.document.framework == "carekit")
        #expect(
            page.document.url == "https://carekit-apple.github.io/CareKit/documentation/carekit/octask")
    }

    @Test("extractReferences keeps only same-archive references")
    func extractReferencesCareKit() {
        let adapter = ExternalDoccAdapter()
        let refs = adapter.extractReferences("carekit/octask", .json(Array(Self.careKitPage.utf8)))
        #expect(refs == ["carekit/octask/init"])
    }

    // MARK: - discover over a stub (detection + index enumeration)

    // technologies.json: one probe-accepted external archive (exampledoc), one probe-REJECTED
    // candidate (baddoc — a non-DocC payload), one structurally-rejected link (github, no
    // /documentation/), a non-https link, a curated dup (carekit), and the apple corpus.
    private static let technologiesJSON = """
        {"sections":[{"kind":"technologies","groups":[{"name":"Frameworks","technologies":[\
        {"title":"Example Doc","destination":{"identifier":"https://example.com/documentation/exampledoc"}},\
        {"title":"Bad Doc","destination":{"identifier":"https://baddoc.example/documentation/baddoc"}},\
        {"title":"ResearchKit","destination":{"identifier":"https://github.com/ResearchKit/ResearchKit"}},\
        {"title":"SwiftUI","destination":{"identifier":"doc://com.apple.SwiftUI/documentation/swiftui"}},\
        {"title":"CareKit","destination":{"identifier":"https://carekit-apple.github.io/CareKit/documentation/carekit"}},\
        {"title":"Foundation","destination":{"identifier":"https://developer.apple.com/documentation/foundation"}}\
        ]}]}]}
        """

    private static func swiftIndex(_ paths: [String]) -> String {
        let nodes = paths.map { "{\"path\":\"\($0)\"}" }.joined(separator: ",")
        return "{\"interfaceLanguages\":{\"swift\":[\(nodes)]}}"
    }

    @Test("discover detects beyond the curated set (probe-gated) and enumerates each index")
    func discoverDetectsAndEnumerates() async throws {
        let doccPayload = "{\"schemaVersion\":{\"major\":0},\"kind\":\"symbol\",\"metadata\":{\"title\":\"X\"}}"
        let context = SourceContext(
            client: StubHTTPClient { request in
                switch request.head.url?.absoluteString ?? "" {
                    case "https://developer.apple.com/tutorials/data/documentation/technologies.json":
                        return httpResponse(200, body: Self.technologiesJSON)
                    // Detection probes: exampledoc is a real DocC archive; baddoc is not.
                    case "https://example.com/data/documentation/exampledoc.json":
                        return httpResponse(200, body: doccPayload)
                    case "https://baddoc.example/data/documentation/baddoc.json":
                        return httpResponse(200, body: "{\"title\":\"not docc\"}")
                    // Per-archive index walks (curated three + the detected exampledoc).
                    case "https://carekit-apple.github.io/CareKit/index/index.json":
                        // A foreign path (otherfw/x) is filtered out by the slug check.
                        return httpResponse(
                            200,
                            body: Self.swiftIndex([
                                "/documentation/carekit", "/documentation/carekit/octask",
                                "/documentation/otherfw/x"
                            ]))
                    case "https://security.apple.com/index/index.json":
                        return httpResponse(200, body: Self.swiftIndex(["/documentation/private-cloud-compute"]))
                    case "https://www.swift.org/index/index.json":
                        return httpResponse(200, body: Self.swiftIndex(["/documentation/docc"]))
                    case "https://example.com/index/index.json":
                        return httpResponse(200, body: Self.swiftIndex(["/documentation/exampledoc"]))
                    default:
                        return httpResponse(404)
                }
            }, rateLimiter: instantRateLimiter())

        let discovery = try await ExternalDoccAdapter().discover(context)

        #expect(
            discovery.keys == [
                "carekit", "carekit/octask", "private-cloud-compute", "docc", "exampledoc"
            ])
        // Curated (literal order) then the probe-detected archive; baddoc never appears.
        #expect(discovery.roots.map(\.slug) == ["carekit", "private-cloud-compute", "docc", "exampledoc"])
        #expect(discovery.roots.allSatisfy { $0.source == "external-docc" })
        #expect(discovery.roots.allSatisfy { $0.sourceType == "external-docc" })
        #expect(discovery.roots.allSatisfy { $0.seedPath == $0.slug })
    }

    // MARK: - enumerateBfs fallback (archives without a linkable index)

    @Test("enumerateBfs walks same-archive references from the slug seed, bounded")
    func bfsFallback() async throws {
        // root → child1, child2 (kept) + other/thing (foreign, dropped). Children are leaves.
        let rootPayload = """
            {"schemaVersion":{"major":0},"kind":"symbol","topicSections":[{"identifiers":[\
            "doc://com.example/documentation/root/child1",\
            "doc://com.example/documentation/root/child2",\
            "doc://com.example/documentation/other/thing"]}]}
            """
        let leaf = "{\"schemaVersion\":{\"major\":0},\"kind\":\"symbol\"}"
        let context = SourceContext(
            client: StubHTTPClient { request in
                switch request.head.url?.absoluteString ?? "" {
                    case "https://bfs.example/data/documentation/root.json":
                        return httpResponse(200, body: rootPayload)
                    case "https://bfs.example/data/documentation/root/child1.json",
                        "https://bfs.example/data/documentation/root/child2.json":
                        return httpResponse(200, body: leaf)
                    default:
                        return httpResponse(404)  // other/thing is foreign — never fetched
                }
            }, rateLimiter: instantRateLimiter())

        let adapter = ExternalDoccAdapter()
        let archive = ExternalDoccAdapter.Archive(
            displayName: "Root", kind: "framework", baseUrl: "https://bfs.example")
        let keys = await adapter.enumerateBfs("root", archive, context)
        #expect(keys == ["root", "root/child1", "root/child2"])
    }
}
