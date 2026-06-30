import ADJSONCore
import Testing

@testable import ADWebBuild

// The build driver: corpus reader → BuildInputs → artifact tree, via injected
// I/O. Exercised with an in-memory mock (the real StorageConnection adapter is a
// later wiring slice).

private struct MockCorpus: CorpusReader {
    let roots: [CorpusRoot]
    let fonts: JSON?
    let symbols: [(scope: String, count: Int)]
    func corpusRoots() -> [CorpusRoot] { roots }
    func fontFamilies() -> JSON? { fonts }
    func symbolTotals() -> [(scope: String, count: Int)] { symbols }
}

@Test func driverCollectsInputsFromCorpus() {
    let reader = MockCorpus(
        roots: [
            CorpusRoot(slug: "combine", displayName: "Combine", kind: "framework", documentCount: 3),
            CorpusRoot(slug: "design", displayName: "Human Interface Guidelines", kind: "design", documentCount: 5),
        ],
        fonts: nil, symbols: [(scope: "public", count: 10), (scope: "private", count: 2)])
    let inputs = BuildSite.collectInputs(from: reader, version: "1.2.3")

    #expect(inputs.indexFrameworks.count == 2)
    #expect(inputs.indexFrameworks[0].slug == "combine")
    #expect(inputs.indexFrameworks[0].kind == "framework")
    #expect(inputs.indexFrameworks[1].displayName == "Human Interface Guidelines")
    #expect(inputs.frameworkMeta.count == 2)
    #expect(inputs.totalDocuments == 8)
    #expect(inputs.symbolTotals.count == 2)
    #expect(inputs.version == "1.2.3")
}

@Test func driverWritesEssentialsTree() throws {
    let reader = MockCorpus(
        roots: [CorpusRoot(slug: "combine", displayName: "Combine", kind: "framework", documentCount: 3)],
        fonts: nil, symbols: [(scope: "public", count: 10), (scope: "private", count: 2)])
    let config = SiteConfig(
        baseUrl: "https://x.test", siteName: "Docs", assetVersion: "v1", bundled: true, buildDate: "2026-06-30")

    var dirs: [String] = []
    var written: [String: String] = [:]
    let result = BuildSite.writeEssentials(
        config: config, reader: reader, version: "1.2.3",
        ensureDir: { dirs.append($0) },
        write: { written[$0.path] = String(decoding: $0.bytes, as: UTF8.self) })

    // Directories ensured + full artifact set written.
    #expect(dirs == BuildSite.directories)
    #expect(written["index.html"]?.hasPrefix("<!DOCTYPE html>") == true)
    #expect(written["data/frameworks/combine.json"] != nil)
    #expect(
        written["manifest.json"]?.contains("\"totalDocuments\": 3,\n  \"totalFrameworks\": 1") == true)

    // The roster + symbol totals flowed into the rendered pages.
    #expect(written["index.html"]?.contains("data-filter-kind=\"framework\"") == true)
    #expect(written["index.html"]?.contains("<a href=\"https://x.test/docs/combine/\">Combine</a>") == true)
    #expect(
        written["symbols/index.html"]?.contains(
            "<span id=\"symbols-count\">12</span> symbols indexed (10 public, 2 private)") == true)

    // Stub ledger surfaced to the caller.
    #expect(!result.stubs.isEmpty)
}
