// Per-page planners for the document render loop (build.js step 5,
// src/web/build/document-pages.js). Pure: map a document + its sections onto the
// output Artifact, routing through the byte-exact DocPage renderer. The driver
// enumerates the corpus and supplies knownKeys / ancestorTitles; the I/O sink
// writes the result.

import ADBase

public import ADContent
public import ADJSONCore

extension BuildSite {
    /// Render one document page → `docs/<safeWebDocKey(key)>/index.html`.
    /// `safeWebDocKey` keeps overlong segments under the 255-byte filesystem
    /// component limit; the live route resolves the same hashed path, so the
    /// canonical URL is identical live vs. static.
    public static func planDocumentPage(
        doc: DocRecord, sections: [DocSection], config: SiteConfig,
        knownKeys: Set<String>? = nil, ancestorTitles: [String: String] = [:],
        markdownDocs: Bool = false, highlight: CodeHighlight? = nil
    ) -> Artifact {
        let html = DocPage.render(
            doc: doc, sections: sections, config: config, knownKeys: knownKeys,
            ancestorTitles: ancestorTitles, markdownDocs: markdownDocs, highlight: highlight)
        let webKey = SafePath.safeWebDocKey(doc.key ?? "")
        return Artifact(path: "docs/\(webKey)/index.html", text: html)
    }

    /// Render one framework listing page (build.js step 6 /
    /// build/framework-pages.js) → `docs/<slug>/index.html`, plus the
    /// content-hashed `data/frameworks/<slug>/tree.<sha256(json)[:10]>.json`
    /// sidecar when the framework has tree edges (the HTML then carries only a
    /// `data-tree-src` ref, never the inline payload). Returns [sidecar?, html].
    public static func planFrameworkPage(
        framework: FrameworkRecord, documents: [JSON], config: SiteConfig,
        treeEdges: [(fromKey: String, toKey: String)] = []
    ) -> [Artifact] {
        let slug = framework.slug ?? ""
        var artifacts: [Artifact] = []
        let tree = FrameworkPage.buildFrameworkTreeData(documents: documents, treeEdges: treeEdges, config: config)
        var treeDataUrl: String?
        if tree.hasTree {
            let hash = String(Sha256.hexString(tree.json).prefix(10))
            let treeRel = "data/frameworks/\(slug)/tree.\(hash).json"
            artifacts.append(Artifact(path: treeRel, text: tree.json))
            treeDataUrl = "\(config.baseUrl)/\(treeRel)"
        }
        let html = FrameworkPage.render(
            framework: framework, documents: documents, config: config, treeEdges: treeEdges,
            treeDataUrl: treeDataUrl)
        artifacts.append(Artifact(path: "docs/\(slug)/index.html", text: html))
        return artifacts
    }
}
