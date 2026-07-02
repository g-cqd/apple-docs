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
    /// render-cache.js `getRoleHeadings(keys)` — role_heading per key, misses
    /// dropped. Backs the topics-section enrichment; defaults to empty (no
    /// enrichment) for corpora/mocks without the index.
    func roleHeadings(forKeys keys: [String]) -> [String: String]
}

extension DocumentCorpusReader {
    public func roleHeadings(forKeys keys: [String]) -> [String: String] { [:] }
}

extension BuildSite {
    /// Essentials + the per-document + framework-listing render loop. I/O is
    /// injected (`ensureDir`/`write`); each page's parent directory is ensured
    /// before its write (the JS `ensureDir(dirname(filePath))` per page).
    /// Topics sections pass through the role-heading enrichment; the manifest
    /// is re-emitted LAST with the RENDERED totals (build.js step 9 — the
    /// essentials pass wrote a 0/0 one). Returns the build result with the
    /// doc-loop step removed from the stub ledger.
    @discardableResult
    public static func writeAll<R: DocumentCorpusReader>(
        config: SiteConfig, reader: R, version: String? = nil, markdownDocs: Bool = false,
        highlight: CodeHighlight? = nil, searchArtifacts: SearchArtifactsStats? = nil,
        ensureDir: (String) throws -> Void, write: ArtifactSink
    ) rethrows -> BuildResult {
        let essentials = try writeEssentials(
            config: config, reader: reader, version: version, searchArtifacts: searchArtifacts,
            ensureDir: ensureDir, write: write)

        var pagesRendered = 0
        var frameworksBuilt = 0
        let known = reader.knownKeys()
        for root in reader.corpusRoots() {
            for bd in reader.documents(inFramework: root.slug) {
                let sections = enrichTopicSections(bd.sections) { reader.roleHeadings(forKeys: $0) }
                let artifact = planDocumentPage(
                    doc: bd.doc, sections: sections, config: config, knownKeys: known,
                    ancestorTitles: bd.ancestorTitles, markdownDocs: markdownDocs, highlight: highlight)
                try ensureDir(parentDir(artifact.path))
                try write(artifact)
                pagesRendered += 1
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
                frameworksBuilt += 1
            }
        }

        // build.js step 9: the manifest is written AFTER the render loop with
        // the rendered counts (pagesBuilt + pagesSkipped / frameworksBuilt).
        var inputs = collectInputs(
            from: reader, config: config, version: version, searchArtifacts: searchArtifacts)
        inputs.totalDocuments = pagesRendered
        inputs.totalFrameworks = frameworksBuilt
        try write(planManifest(config: config, inputs: inputs))

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
