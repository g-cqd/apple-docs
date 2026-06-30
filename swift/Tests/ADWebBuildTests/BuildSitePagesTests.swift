import ADJSONCore
import Testing

@testable import ADContent
@testable import ADWebBuild

private func combineDocs() -> [JSON] {
    let root = try? ADJSON.parse(
        #"[{"key":"combine/publisher","title":"Publisher","role":"symbol","role_heading":"Protocol"},{"key":"combine/just","title":"Just","role":"symbol","role_heading":"Structure"},{"key":"combine/using-combine","title":"Using Combine","role":"article","role_heading":"Article"}]"#,
        options: .init(maxDepth: 512)
    ).root
    var out: [JSON] = []
    root?.forEachElement { out.append($0) }
    return out
}

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

@Test func planFrameworkPageWithTreeSidecar() {
    let combine = FrameworkRecord(slug: "combine", displayName: "Combine", kind: "framework")
    let config = SiteConfig(
        baseUrl: "https://x.test", siteName: "Docs", assetVersion: "v1", bundled: true, buildDate: "2026-06-30")
    let edges: [(fromKey: String, toKey: String)] = [(fromKey: "combine", toKey: "combine/publisher")]

    let artifacts = BuildSite.planFrameworkPage(
        framework: combine, documents: combineDocs(), config: config, treeEdges: edges)

    #expect(artifacts.count == 2)
    // Content-hashed sidecar first (sha256(tree.json)[:10] = 3e57e4c6ac).
    #expect(artifacts[0].path == "data/frameworks/combine/tree.3e57e4c6ac.json")
    #expect(String(decoding: artifacts[0].bytes, as: UTF8.self).hasPrefix("{\"edges\":["))
    // HTML carries the external data-tree-src ref, never the inline payload.
    #expect(artifacts[1].path == "docs/combine/index.html")
    #expect(
        String(decoding: artifacts[1].bytes, as: UTF8.self).contains(
            "<div id=\"tree-container\" data-tree-src=\"https://x.test/data/frameworks/combine/tree.3e57e4c6ac.json\"></div>"
        ))
}

@Test func planFrameworkPageTreeless() {
    let combine = FrameworkRecord(slug: "combine", displayName: "Combine", kind: "framework")
    let config = SiteConfig(
        baseUrl: "https://x.test", siteName: "Docs", assetVersion: "v1", bundled: true, buildDate: "2026-06-30")

    let artifacts = BuildSite.planFrameworkPage(framework: combine, documents: combineDocs(), config: config)

    #expect(artifacts.count == 1)
    #expect(artifacts[0].path == "docs/combine/index.html")
    #expect(String(decoding: artifacts[0].bytes, as: UTF8.self).contains("<div id=\"tree-container\"></div>"))
}
