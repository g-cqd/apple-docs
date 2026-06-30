import Testing

@testable import ADContent
@testable import ADWebBuild

// The document-page planner: correct output path + faithful pass-through to the
// byte-exact DocPage renderer.

@Test func planDocumentPageRoutesThroughRenderer() {
    let doc = DocRecord(
        key: "swiftui/view", title: "View", framework: "swiftui", frameworkDisplay: "SwiftUI",
        roleHeading: "Protocol", isDeprecated: false, isBeta: false, platformsJson: nil, url: nil,
        abstractText: "A view.", language: "swift")
    let sections = [
        DocSection(
            sectionKind: "abstract", heading: nil, contentText: nil,
            contentJson: #"[{"type":"text","text":"A view."}]"#, sortOrder: 0)
    ]
    let config = SiteConfig(
        baseUrl: "https://x.test", siteName: "Docs", assetVersion: "v1", bundled: true, buildDate: "2026-06-30")
    let known: Set<String> = ["swiftui", "swiftui/view"]

    let artifact = BuildSite.planDocumentPage(doc: doc, sections: sections, config: config, knownKeys: known)

    #expect(artifact.path == "docs/swiftui/view/index.html")
    let html = String(decoding: artifact.bytes, as: UTF8.self)
    #expect(html == DocPage.render(doc: doc, sections: sections, config: config, knownKeys: known))
    #expect(html.contains("<title>View — Docs</title>"))
    #expect(html.hasPrefix("<!DOCTYPE html>"))
}
