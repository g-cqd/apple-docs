// The full render loop — essentials + per-document pages + framework listing
// pages (build.js steps 4-9, minus the still-stubbed search-artifacts/sitemap/
// assets). Dependency-inverted via `DocumentCorpusReader` so the template module
// stays SQLite-free; I/O is injected. The ADStorage adapter conforms the reader;
// tests use a mock.

import ADBase

public import ADContent
public import ADJSONCore

/// One document ready to render: its record, sections, and the ancestor-title
/// map for breadcrumbs (`renderCache.getAncestorTitles` in the JS build).
public struct BuildDocument: Sendable {
    public let doc: DocRecord
    public let sections: [DocSection]
    public let ancestorTitles: [String: String]
    public init(doc: DocRecord, sections: [DocSection], ancestorTitles: [String: String] = [:]) {
        self.doc = doc
        self.sections = sections
        self.ancestorTitles = ancestorTitles
    }
}

/// A corpus reader that also enumerates documents + framework-page data for the
/// full build. ADStorage's `StorageConnection` adapter conforms; tests mock it.
public protocol DocumentCorpusReader: CorpusReader {
    /// Every document key in the corpus — used for in-page link resolution.
    func knownKeys() -> Set<String>
    /// The documents to render under one framework slug (`documents.framework = ?`).
    func documents(inFramework slug: String) -> [BuildDocument]
    /// The framework listing page's document list (`getPagesByRoot` — root
    /// membership, not the `framework` column). Empty → no listing page.
    func frameworkPageDocuments(slug: String) -> [JSON]
    /// The framework's tree edges (`getFrameworkTree`).
    func frameworkTreeEdges(slug: String) -> [(fromKey: String, toKey: String)]
}

extension BuildSite {
    /// Essentials + the per-document + framework-listing render loop. I/O is
    /// injected (`ensureDir`/`write`); each page's parent directory is ensured
    /// before its write (the JS `ensureDir(dirname(filePath))` per page). Returns
    /// the build result with the doc-loop step removed from the stub ledger.
    @discardableResult
    public static func writeAll<R: DocumentCorpusReader>(
        config: SiteConfig, reader: R, version: String? = nil, markdownDocs: Bool = false,
        highlight: CodeHighlight? = nil, ensureDir: (String) throws -> Void, write: ArtifactSink
    ) rethrows -> BuildResult {
        let essentials = try writeEssentials(
            config: config, reader: reader, version: version, ensureDir: ensureDir, write: write)

        let known = reader.knownKeys()
        for root in reader.corpusRoots() {
            for bd in reader.documents(inFramework: root.slug) {
                let artifact = planDocumentPage(
                    doc: bd.doc, sections: bd.sections, config: config, knownKeys: known,
                    ancestorTitles: bd.ancestorTitles, markdownDocs: markdownDocs, highlight: highlight)
                try ensureDir(parentDir(artifact.path))
                try write(artifact)
            }

            let fwDocs = reader.frameworkPageDocuments(slug: root.slug)
            if !fwDocs.isEmpty {
                let framework = FrameworkRecord(
                    slug: root.slug, displayName: root.displayName, kind: root.kind,
                    sourceType: root.sourceType, url: root.url)
                let pages = planFrameworkPage(
                    framework: framework, documents: fwDocs, config: config,
                    treeEdges: reader.frameworkTreeEdges(slug: root.slug))
                for artifact in pages {
                    try ensureDir(parentDir(artifact.path))
                    try write(artifact)
                }
            }
        }

        return BuildResult(
            dirs: essentials.dirs, artifacts: essentials.artifacts,
            stubs: essentials.stubs.filter { !$0.contains("document pages") })
    }

    /// The directory portion of a relative artifact path
    /// (`docs/a/b/index.html` → `docs/a/b`; no slash → "").
    static func parentDir(_ path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[path.startIndex ..< slash])
    }
}
