// The build driver — bridges a corpus reader to the BuildSite planner and an
// injected I/O sink. Kept dependency-inverted (a `CorpusReader` protocol instead
// of a direct ADStorage import) so the template module stays SQLite-free and the
// driver is testable against an in-memory mock. The real adapter
// (`StorageConnection: CorpusReader`) + the `ad-cli web build` verb + the
// Foundation file sink are the thin remaining wiring.

public import ADJSONCore

/// One framework root, as the build needs it (index roster + per-framework
/// metadata). Mirrors the `roots` row the JS homepage/build read.
public struct CorpusRoot: Sendable {
    public let slug: String
    public let displayName: String?
    public let kind: String?
    public let documentCount: Int
    /// `source_type` + `url` for the framework page's original-resource link
    /// (`frameworkOriginalUrl`); nil → synthesized from the slug.
    public let sourceType: String?
    public let url: String?
    public init(
        slug: String, displayName: String?, kind: String?, documentCount: Int,
        sourceType: String? = nil, url: String? = nil
    ) {
        self.slug = slug
        self.displayName = displayName
        self.kind = kind
        self.documentCount = documentCount
        self.sourceType = sourceType
        self.url = url
    }
}

/// The corpus reads the essentials build needs. ADStorage's `StorageConnection`
/// will conform via a small adapter (the `listRoots` / `listAppleFonts`
/// / `sf_symbols` readers); tests use an in-memory mock.
public protocol CorpusReader {
    /// The BUILD's root walk (`db.getRoots()` — every root, ORDER BY slug):
    /// drives the doc/framework render loops and the per-framework metadata.
    func corpusRoots() -> [CorpusRoot]
    /// The homepage ROSTER (buildHomepageProps): `getRoots()` minus roots whose
    /// only page is the root itself. Defaults to `corpusRoots()` for corpora /
    /// mocks without the pages probe.
    func homepageRoots() -> [CorpusRoot]
    /// The `/fonts` payload (parsed JSON array), or nil when no fonts indexed.
    func fontFamilies() -> JSON?
    /// `SELECT scope, COUNT(*) FROM sf_symbols GROUP BY scope`.
    func symbolTotals() -> [(scope: String, count: Int)]
}

extension CorpusReader {
    public func homepageRoots() -> [CorpusRoot] { corpusRoots() }
}

/// Where the driver hands each rendered artifact (the ad-cli verb supplies a
/// Foundation file writer; tests collect into an array).
public typealias ArtifactSink = (Artifact) throws -> Void

extension BuildSite {
    /// `buildHomepageExtras(siteConfig)` — the synthetic Fonts/Symbols entries
    /// injected into the homepage's `design` kind (no backing root, but full
    /// pages of their own at /fonts and /symbols).
    public static func homepageExtras(_ config: SiteConfig) -> [(kind: String, items: [IndexFramework])] {
        [
            (
                kind: "design",
                items: [
                    IndexFramework(
                        kind: "design", slug: "fonts", displayName: "Apple Fonts",
                        href: "\(config.baseUrl)/fonts"),
                    IndexFramework(
                        kind: "design", slug: "symbols", displayName: "SF Symbols",
                        href: "\(config.baseUrl)/symbols"),
                ]
            )
        ]
    }

    /// Map a corpus reader into the essentials `BuildInputs`, with the homepage
    /// Fonts/Symbols extras.
    ///
    /// GAP (page-count filter, the adapter's job): the JS `buildHomepageProps`
    /// also drops roots whose only page is the root itself — that needs
    /// `getPagesByRoot`, so the ADStorage adapter pre-filters `corpusRoots()`;
    /// this maps whatever roots it's given. The manifest totals are 0 here — the
    /// essentials build renders no pages (build.js reports rendered counts, so
    /// `--skip-docs` is 0/0); the full render loop sets them.
    public static func collectInputs<R: CorpusReader>(
        from reader: R, config: SiteConfig, version: String? = nil,
        searchArtifacts: SearchArtifactsStats? = nil
    ) -> BuildInputs {
        // Homepage roster (buildHomepageProps' filtered getRoots) vs the
        // build's UNFILTERED walk: metadata (build.js step 8) iterates every
        // root, the index roster drops self-page-only roots.
        // No count badge: `roots` has no doc_count column (getRoots = SELECT *
        // FROM roots), so the JS homepage's fw.doc_count is always undefined.
        let frameworks = reader.homepageRoots().map {
            IndexFramework(kind: $0.kind, slug: $0.slug, displayName: $0.displayName, docCount: nil)
        }
        let meta = reader.corpusRoots().map {
            FrameworkMeta(slug: $0.slug, displayName: $0.displayName, kind: $0.kind, documentCount: $0.documentCount)
        }
        return BuildInputs(
            indexFrameworks: frameworks, indexExtras: homepageExtras(config),
            fontFamilies: reader.fontFamilies(), symbolTotals: reader.symbolTotals(), frameworkMeta: meta,
            version: version, totalDocuments: 0, totalFrameworks: 0, searchArtifacts: searchArtifacts)
    }

    /// Collect → plan → ensure dirs → write the essentials artifact tree. I/O is
    /// injected (`ensureDir`/`write`) so this stays Foundation-free. Returns the
    /// `BuildResult` (so the caller can log the stub ledger). `searchArtifacts`
    /// carries the S3 step's counts into the manifest (build.js step 7 → 9).
    @discardableResult
    public static func writeEssentials<R: CorpusReader>(
        config: SiteConfig, reader: R, version: String? = nil,
        searchArtifacts: SearchArtifactsStats? = nil,
        ensureDir: (String) throws -> Void, write: ArtifactSink
    ) rethrows -> BuildResult {
        let inputs = collectInputs(
            from: reader, config: config, version: version, searchArtifacts: searchArtifacts)
        let result = planEssentials(config: config, inputs: inputs)
        for dir in result.dirs { try ensureDir(dir) }
        for artifact in result.artifacts { try write(artifact) }
        return result
    }
}
