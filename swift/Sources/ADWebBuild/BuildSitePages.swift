// Per-page planners for the document render loop (build.js step 5,
// src/web/build/document-pages.js). Pure: map a document + its sections onto the
// output Artifact, routing through the byte-exact DocPage renderer. The driver
// enumerates the corpus and supplies knownKeys / ancestorTitles; the I/O sink
// writes the result.

import ADBase

public import ADContent

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
}
