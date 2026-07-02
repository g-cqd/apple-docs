import Testing

@testable import ADWebBuild

// S3 search artifacts: planSearchArtifacts byte-exact vs the bun oracle
// (JSON.stringify framing + sha256(json).slice(0,10) content hashes, generated
// with `bun -e` over src/web/search-artifacts.js semantics). Fixtures hoisted
// to file scope for the 100ms type-check budget.

private let titleFixture = TitleIndexData(
    frameworks: ["foundation", "swiftui"],
    keys: ["foundation", "swiftui", "swiftui/view"],
    titles: ["Foundation", "SwiftUI", "View"],
    abstracts: [
        "Essential data types & collections.", "Declarative UI.", "A view with “quotes” and <tags>.",
    ],
    fwIndices: [0, 1, 1],
    kinds: ["framework", "framework", "symbol"],
    roleHeadings: ["", "", "Protocol"])

/// `JSON.stringify(titleIndex)` from bun; sha256 prefix 266c61f39e.
private let titleFixtureJson =
    "{\"v\":2,\"frameworks\":[\"foundation\",\"swiftui\"],\"keys\":[\"foundation\",\"swiftui\",\"swiftui/view\"],\"titles\":[\"Foundation\",\"SwiftUI\",\"View\"],\"abstracts\":[\"Essential data types & collections.\",\"Declarative UI.\",\"A view with “quotes” and <tags>.\"],\"fwIndices\":[0,1,1],\"kinds\":[\"framework\",\"framework\",\"symbol\"],\"roleHeadings\":[\"\",\"\",\"Protocol\"]}"

private let shardDocsFixture = [
    ShardDoc(key: "swiftui", framework: "swiftui", body: "Views are the building blocks."),
    ShardDoc(key: "swiftui/view", framework: "swiftui", body: "protocol View"),
    ShardDoc(key: "foundation", framework: "Foundation", body: "Data types."),
    ShardDoc(key: "empty/doc", framework: "swiftui", body: ""),  // no body ⇒ no entry
    ShardDoc(key: "3dkit", framework: "3dkit", body: "three dee"),  // non-letter ⇒ _
    ShardDoc(key: "orphan", framework: nil, body: "no framework"),  // nil ⇒ _
]

private func artifactText(_ artifacts: [Artifact], _ path: String) -> String? {
    artifacts.first { $0.path == path }.map { String(decoding: $0.bytes, as: UTF8.self) }
}

@Test func titleIndexArtifactByteExact() {
    let (artifacts, stats) = BuildSite.planSearchArtifacts(
        corpus: SearchCorpus(titleIndex: titleFixture), generatedAt: "2026-01-01T00:00:00.000Z")
    // sha256(json).slice(0,10) = 266c61f39e (pinned from bun).
    #expect(artifactText(artifacts, "data/search/title-index.266c61f39e.json") == titleFixtureJson)
    #expect(stats.titleCount == 3)
}

@Test func aliasArtifactEmptyAndOrdered() {
    // Empty map: JSON.stringify({}) = "{}", sha256 prefix 44136fa355.
    let (empty, emptyStats) = BuildSite.planSearchArtifacts(
        corpus: SearchCorpus(), generatedAt: "2026-01-01T00:00:00.000Z")
    #expect(artifactText(empty, "data/search/aliases.44136fa355.json") == "{}")
    #expect(emptyStats.aliasCount == 0)

    // JS object own-key order: integer-like keys ascending FIRST, then
    // insertion order; a duplicate keeps first position + last value. Pinned:
    // {"10":"ten","2020":"wwdc","swiftui-alias":"swiftui2","a":"x"}
    let pairs = BuildSite.jsObjectPairs([
        ("swiftui-alias", "swiftui"), ("2020", "wwdc"), ("10", "ten"), ("a", "x"),
        ("swiftui-alias", "swiftui2"),
    ])
    #expect(pairs.map(\.0) == ["10", "2020", "swiftui-alias", "a"])
    #expect(pairs.map(\.1) == ["ten", "wwdc", "swiftui2", "x"])
}

@Test func shardLetterMatchesJs() {
    // Pinned from bun: ["swiftui","Foundation","3dkit","_x","","émoji"] → s f _ _ _ _.
    #expect(BuildSite.shardLetter("swiftui") == "s")
    #expect(BuildSite.shardLetter("Foundation") == "f")
    #expect(BuildSite.shardLetter("3dkit") == "_")
    #expect(BuildSite.shardLetter("_x") == "_")
    #expect(BuildSite.shardLetter("") == "_")
    #expect(BuildSite.shardLetter("émoji") == "_")
    #expect(BuildSite.shardLetter(nil) == "_")
}

@Test func bodyShardsGroupHashAndManifest() {
    let (artifacts, stats) = BuildSite.planSearchArtifacts(
        corpus: SearchCorpus(hasSections: true, shardDocs: shardDocsFixture),
        generatedAt: "2026-01-01T00:00:00.000Z")

    // Shard s: {"swiftui":"…","swiftui/view":"…"} — pinned json + hash 65c7bd8f6b.
    #expect(
        artifactText(artifacts, "data/search/shards/s.65c7bd8f6b.json")
            == "{\"swiftui\":\"Views are the building blocks.\",\"swiftui/view\":\"protocol View\"}")
    // Letters in first-appearance order: s (swiftui), f (Foundation), _ (3dkit).
    let shardPaths: [String] = artifacts.map(\.path).filter { $0.hasPrefix("data/search/shards/") }
    #expect(shardPaths.count == 3)
    #expect(shardPaths[0].hasPrefix("data/search/shards/s."))
    #expect(shardPaths[1].hasPrefix("data/search/shards/f."))
    #expect(shardPaths[2].hasPrefix("data/search/shards/_."))
    #expect(stats.shardCount == 3)
    // empty-body doc created no entry anywhere.
    #expect(!artifacts.contains { String(decoding: $0.bytes, as: UTF8.self).contains("empty/doc") })
}

@Test func manifestBytesExact() {
    // Pinned from bun with the same counts/hashes (title 266c…, aliases 4413…,
    // shard files abc/def substituted by the REAL hashes below).
    let corpus = SearchCorpus(titleIndex: titleFixture)
    let (artifacts, _) = BuildSite.planSearchArtifacts(corpus: corpus, generatedAt: "2026-01-01T00:00:00.000Z")
    let manifest = artifactText(artifacts, "data/search/search-manifest.json")
    #expect(
        manifest
            == "{\"version\":2,\"titleCount\":3,\"aliasCount\":0,\"shardCount\":0,\"files\":{\"title-index\":\"title-index.266c61f39e.json\",\"aliases\":\"aliases.44136fa355.json\"},\"generatedAt\":\"2026-01-01T00:00:00.000Z\"}")
}

@Test func liteTierTouchesEmptyShards() {
    // hasSections=false: every doc's letter is touched, but no entries are
    // emitted ("{}" shards) — the JS lite-tier branch.
    let (artifacts, stats) = BuildSite.planSearchArtifacts(
        corpus: SearchCorpus(hasSections: false, shardDocs: shardDocsFixture),
        generatedAt: "2026-01-01T00:00:00.000Z")
    let shardPaths: [String] = artifacts.map(\.path).filter { $0.hasPrefix("data/search/shards/") }
    #expect(shardPaths.count == 3)  // s, f, _
    for path in shardPaths {
        #expect(artifactText(artifacts, path) == "{}")
    }
    #expect(stats.shardCount == 3)
}
