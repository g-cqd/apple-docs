import ADJSONCore
import Testing

@testable import ADWebBuild

// The build driver: corpus reader → BuildInputs → artifact tree, via injected
// I/O. Exercised with an in-memory mock (the real StorageConnection adapter is a
// later wiring slice). Test data is hoisted to file scope to stay under the
// 100ms type-check budget.

private struct MockCorpus: CorpusReader {
    let roots: [CorpusRoot]
    let fonts: JSON?
    let symbols: [(scope: String, count: Int)]
    func corpusRoots() -> [CorpusRoot] { roots }
    func fontFamilies() -> JSON? { fonts }
    func symbolTotals() -> [(scope: String, count: Int)] { symbols }
}

private let driverSymbols: [(scope: String, count: Int)] = [
    (scope: "public", count: 10), (scope: "private", count: 2),
]
private let twoRoots: [CorpusRoot] = [
    CorpusRoot(slug: "combine", displayName: "Combine", kind: "framework", documentCount: 3),
    CorpusRoot(slug: "design", displayName: "Human Interface Guidelines", kind: "design", documentCount: 5),
]
private let oneRoot: [CorpusRoot] = [
    CorpusRoot(slug: "combine", displayName: "Combine", kind: "framework", documentCount: 3)
]
private let driverConfig = SiteConfig(
    baseUrl: "https://x.test", siteName: "Docs", assetVersion: "v1", bundled: true, buildDate: "2026-06-30")

@Test func driverCollectsInputsFromCorpus() {
    let reader = MockCorpus(roots: twoRoots, fonts: nil, symbols: driverSymbols)
    let inputs = BuildSite.collectInputs(from: reader, config: driverConfig, version: "1.2.3")

    #expect(inputs.indexFrameworks.count == 2)
    #expect(inputs.indexFrameworks[0].slug == "combine")
    #expect(inputs.indexFrameworks[0].kind == "framework")
    #expect(inputs.indexFrameworks[1].displayName == "Human Interface Guidelines")
    #expect(inputs.frameworkMeta.count == 2)
    #expect(inputs.totalDocuments == 8)
    #expect(inputs.symbolTotals.count == 2)
    #expect(inputs.version == "1.2.3")
}

@Test func driverWiresHomepageExtras() {
    let reader = MockCorpus(roots: twoRoots, fonts: nil, symbols: driverSymbols)
    let inputs = BuildSite.collectInputs(from: reader, config: driverConfig, version: "1.2.3")
    // Homepage Fonts/Symbols extras injected into the design kind.
    #expect(inputs.indexExtras.count == 1)
    #expect(inputs.indexExtras[0].kind == "design")
    #expect(inputs.indexExtras[0].items.count == 2)
}

@Test func driverWritesEssentialsTree() {
    let reader = MockCorpus(roots: oneRoot, fonts: nil, symbols: driverSymbols)
    var dirs: [String] = []
    var written: [String: String] = [:]
    let result = BuildSite.writeEssentials(
        config: driverConfig, reader: reader, version: "1.2.3",
        ensureDir: { dirs.append($0) },
        write: { written[$0.path] = String(decoding: $0.bytes, as: UTF8.self) })

    #expect(dirs == BuildSite.directories)
    #expect(written["index.html"]?.hasPrefix("<!DOCTYPE html>") ?? false)
    #expect(written["data/frameworks/combine.json"] != nil)

    let manifest: String = written["manifest.json"] ?? ""
    #expect(manifest.contains("\"totalDocuments\": 3,\n  \"totalFrameworks\": 1"))

    let index: String = written["index.html"] ?? ""
    #expect(index.contains("data-filter-kind=\"framework\""))
    #expect(index.contains("<a href=\"https://x.test/docs/combine/\">Combine</a>"))

    let symbols: String = written["symbols/index.html"] ?? ""
    #expect(symbols.contains("<span id=\"symbols-count\">12</span> symbols indexed (10 public, 2 private)"))

    #expect(!result.stubs.isEmpty)
}
