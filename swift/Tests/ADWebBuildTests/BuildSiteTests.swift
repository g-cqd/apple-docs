import Testing

@testable import ADWebBuild

// The orchestrator skeleton (essentials planner). Page bytes are covered by the
// per-template byte-exact suites; here we assert the artifact TREE + the
// build-specific JSON (per-framework metadata, manifest) + the stub ledger.
// Split across functions to stay under the 100ms type-check budget.

private func text(_ result: BuildResult, _ path: String) -> String? {
    result.artifacts.first { $0.path == path }.map { String(decoding: $0.bytes, as: UTF8.self) }
}

private let essentialsConfig = SiteConfig(
    baseUrl: "https://x.test", siteName: "Docs", assetVersion: "v1", bundled: true, buildDate: "2026-06-30")
private let essentialsInputs = BuildInputs(
    indexFrameworks: [IndexFramework(kind: "Frameworks", slug: "combine", displayName: "Combine", docCount: 3)],
    frameworkMeta: [FrameworkMeta(slug: "combine", displayName: "Combine", kind: "framework", documentCount: 3)],
    version: "1.2.3", totalDocuments: 3)

@Test func buildSiteEssentialsArtifactPaths() {
    let result = BuildSite.planEssentials(config: essentialsConfig, inputs: essentialsInputs)

    #expect(result.dirs == BuildSite.directories)

    let paths: [String] = result.artifacts.map(\.path)
    let expected: [String] = [
        "index.html", "search/index.html", "fonts/index.html", "symbols/index.html", "404.html",
        "robots.txt", "opensearch.xml", ".well-known/api-catalog", ".well-known/mcp/server-card.json",
        "_headers", "data/frameworks/combine.json", "manifest.json",
    ]
    #expect(paths == expected)

    #expect(result.stubs == BuildSite.pendingSteps)
    #expect(result.stubs.contains { $0.contains("document pages") })
}

@Test func buildSiteEssentialsArtifactContent() {
    let result = BuildSite.planEssentials(config: essentialsConfig, inputs: essentialsInputs)

    let perFramework: String? = text(result, "data/frameworks/combine.json")
    #expect(perFramework == "{\"slug\":\"combine\",\"displayName\":\"Combine\",\"kind\":\"framework\",\"documentCount\":3}")

    let manifest: String? = text(result, "manifest.json")
    #expect(
        manifest
            == "{\n  \"version\": 1,\n  \"siteName\": \"Docs\",\n  \"buildDate\": \"2026-06-30\",\n  \"baseUrl\": \"https://x.test\",\n  \"totalDocuments\": 3,\n  \"totalFrameworks\": 1,\n  \"searchArtifacts\": null\n}")

    let index: String? = text(result, "index.html")
    #expect(index?.hasPrefix("<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"auto\">") == true)
    let notFound: String? = text(result, "404.html")
    #expect(notFound?.contains("not-found-page") == true)
    let robots: String? = text(result, "robots.txt")
    #expect(robots?.hasPrefix("# As a condition") == true)
}

@Test func buildSiteEmptyCorpus() {
    let config = SiteConfig(baseUrl: "", siteName: "Apple Developer Docs")
    let result = BuildSite.planEssentials(config: config, inputs: BuildInputs())
    // No frameworks → no per-framework metadata, but the essentials still emit.
    let paths: [String] = result.artifacts.map(\.path)
    #expect(paths.contains("index.html"))
    #expect(paths.contains("manifest.json"))
    #expect(!paths.contains { $0.hasPrefix("data/frameworks/") })

    let manifest: String? = text(result, "manifest.json")
    #expect(
        manifest
            == "{\n  \"version\": 1,\n  \"siteName\": \"Apple Developer Docs\",\n  \"buildDate\": null,\n  \"baseUrl\": \"\",\n  \"totalDocuments\": 0,\n  \"totalFrameworks\": 0,\n  \"searchArtifacts\": null\n}")
}
