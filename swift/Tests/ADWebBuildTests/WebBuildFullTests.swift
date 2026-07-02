import ADJSONCore
import Testing

@testable import ADContent
@testable import ADWebBuild

// The full render loop: essentials + per-document pages + framework listing
// pages, via a document-enumerating mock reader through injected I/O. Test data
// is hoisted to file scope to stay under the 100ms type-check budget.

private struct FullMock: DocumentCorpusReader {
    let roots: [CorpusRoot]
    let docsByFw: [String: [BuildDocument]]
    let fwDocs: [String: [JSON]]
    let edges: [String: [(fromKey: String, toKey: String)]]
    let keys: Set<String>
    func corpusRoots() -> [CorpusRoot] { roots }
    func fontFamilies() -> JSON? { nil }
    func symbolTotals() -> [(scope: String, count: Int)] { [] }
    func knownKeys() -> Set<String> { keys }
    func documents(inFramework slug: String) -> [BuildDocument] { docsByFw[slug] ?? [] }
    func frameworkPageDocuments(slug: String) -> [JSON] { fwDocs[slug] ?? [] }
    func frameworkTreeEdges(slug: String) -> [(fromKey: String, toKey: String)] { edges[slug] ?? [] }
}

private func parsed(_ json: String) -> [JSON] {
    let root = try? ADJSON.parse(json, options: .init(maxDepth: 512)).root
    var out: [JSON] = []
    root?.forEachElement { out.append($0) }
    return out
}

private let fullDoc = DocRecord(
    key: "combine/view", title: "View", framework: "combine", frameworkDisplay: "Combine",
    roleHeading: "Protocol", isDeprecated: false, isBeta: false, platformsJson: nil, url: nil,
    abstractText: "A view.", language: "swift")
private let fullSections: [DocSection] = [
    DocSection(
        sectionKind: "abstract", heading: nil, contentText: nil,
        contentJson: #"[{"type":"text","text":"A view."}]"#, sortOrder: 0)
]
private let fullReader = FullMock(
    roots: [CorpusRoot(slug: "combine", displayName: "Combine", kind: "framework", documentCount: 1)],
    docsByFw: ["combine": [BuildDocument(doc: fullDoc, sections: fullSections)]],
    fwDocs: ["combine": parsed(#"[{"key":"combine/view","title":"View","role":"symbol","role_heading":"Protocol"}]"#)],
    edges: [:], keys: ["combine", "combine/view"])
private let fullConfig = SiteConfig(
    baseUrl: "https://x.test", siteName: "Docs", assetVersion: "v1", bundled: true, buildDate: "2026-06-30")

@Test func writeAllRendersEssentialsDocsAndFrameworkPages() {
    var dirs: Set<String> = []
    var written: [String: String] = [:]
    let result = BuildSite.writeAll(
        config: fullConfig, reader: fullReader, version: "1.2.3",
        ensureDir: { dirs.insert($0) },
        write: { written[$0.path] = String(decoding: $0.bytes, as: UTF8.self) })

    // Essentials.
    #expect(written["index.html"] != nil)
    #expect(written["manifest.json"] != nil)
    // Document page.
    let docPage: String = written["docs/combine/view/index.html"] ?? ""
    #expect(docPage.contains("<title>View — Docs</title>"))
    #expect(dirs.contains("docs/combine/view"))
    // Framework listing page (treeless → no sidecar).
    let fwPage: String = written["docs/combine/index.html"] ?? ""
    #expect(fwPage.contains("<h1>Combine</h1>"))
    #expect(dirs.contains("docs/combine"))
    #expect(!written.keys.contains { $0.hasPrefix("data/frameworks/combine/tree.") })

    // A FULL build has no stubs left — WS-C is fully landed; the ledger's
    // one remaining entry (`--skip-docs` doc loop) is filtered out by writeAll.
    #expect(result.stubs.isEmpty)
}
