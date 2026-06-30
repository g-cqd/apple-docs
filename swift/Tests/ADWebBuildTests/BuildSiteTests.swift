import Testing

@testable import ADWebBuild

// The orchestrator skeleton (essentials planner). Page bytes are covered by the
// per-template byte-exact suites; here we assert the artifact TREE + the
// build-specific JSON (per-framework metadata, manifest) + the stub ledger.

private func text(_ result: BuildResult, _ path: String) -> String? {
    result.artifacts.first { $0.path == path }.map { String(decoding: $0.bytes, as: UTF8.self) }
}

@Test func buildSiteEssentialsArtifactTree() {
    let config = SiteConfig(
        baseUrl: "https://x.test", siteName: "Docs", assetVersion: "v1", bundled: true, buildDate: "2026-06-30")
    let inputs = BuildInputs(
        indexFrameworks: [
            IndexFramework(kind: "Frameworks", slug: "combine", displayName: "Combine", docCount: 3)
        ],
        frameworkMeta: [FrameworkMeta(slug: "combine", displayName: "Combine", kind: "framework", documentCount: 3)],
        version: "1.2.3", totalDocuments: 3)
    let result = BuildSite.planEssentials(config: config, inputs: inputs)

    // Directory skeleton.
    #expect(result.dirs == BuildSite.directories)

    // Exact artifact set, in order.
    let paths = result.artifacts.map(\.path)
    #expect(
        paths == [
            "index.html", "search/index.html", "fonts/index.html", "symbols/index.html", "404.html",
            "robots.txt", "opensearch.xml", ".well-known/api-catalog", ".well-known/mcp/server-card.json",
            "_headers", "data/frameworks/combine.json", "manifest.json",
        ])

    // Build-specific JSON, byte-exact.
    #expect(
        text(result, "data/frameworks/combine.json")
            == "{\"slug\":\"combine\",\"displayName\":\"Combine\",\"kind\":\"framework\",\"documentCount\":3}")
    #expect(
        text(result, "manifest.json")
            == "{\n  \"version\": 1,\n  \"siteName\": \"Docs\",\n  \"buildDate\": \"2026-06-30\",\n  \"baseUrl\": \"https://x.test\",\n  \"totalDocuments\": 3,\n  \"totalFrameworks\": 1,\n  \"searchArtifacts\": null\n}")

    // Pages route through the byte-exact renderers (spot-check the shell).
    #expect(text(result, "index.html")?.hasPrefix("<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"auto\">") == true)
    #expect(text(result, "404.html")?.contains("not-found-page") == true)
    #expect(text(result, "robots.txt")?.hasPrefix("# As a condition") == true)

    // The stub ledger is non-empty and names the deferred steps.
    #expect(result.stubs == BuildSite.pendingSteps)
    #expect(result.stubs.contains { $0.contains("document pages") })
}

@Test func buildSiteEmptyCorpus() {
    let config = SiteConfig(baseUrl: "", siteName: "Apple Developer Docs")
    let result = BuildSite.planEssentials(config: config, inputs: BuildInputs())
    // No frameworks → no per-framework metadata, but the essentials still emit.
    let paths = result.artifacts.map(\.path)
    #expect(paths.contains("index.html"))
    #expect(paths.contains("manifest.json"))
    #expect(!paths.contains { $0.hasPrefix("data/frameworks/") })
    #expect(
        text(result, "manifest.json")
            == "{\n  \"version\": 1,\n  \"siteName\": \"Apple Developer Docs\",\n  \"buildDate\": null,\n  \"baseUrl\": \"\",\n  \"totalDocuments\": 0,\n  \"totalFrameworks\": 0,\n  \"searchArtifacts\": null\n}")
}
