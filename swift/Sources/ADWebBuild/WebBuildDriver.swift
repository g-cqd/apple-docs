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
    public init(slug: String, displayName: String?, kind: String?, documentCount: Int) {
        self.slug = slug
        self.displayName = displayName
        self.kind = kind
        self.documentCount = documentCount
    }
}

/// The corpus reads the essentials build needs. ADStorage's `StorageConnection`
/// will conform via a small adapter (the `listFrameworkRoots` / `listAppleFonts`
/// / `sf_symbols` readers); tests use an in-memory mock.
public protocol CorpusReader {
    /// Framework roots — drives the index roster + per-framework metadata.
    func corpusRoots() -> [CorpusRoot]
    /// The `/fonts` payload (parsed JSON array), or nil when no fonts indexed.
    func fontFamilies() -> JSON?
    /// `SELECT scope, COUNT(*) FROM sf_symbols GROUP BY scope`.
    func symbolTotals() -> [(scope: String, count: Int)]
}

/// Where the driver hands each rendered artifact (the ad-cli verb supplies a
/// Foundation file writer; tests collect into an array).
public typealias ArtifactSink = (Artifact) throws -> Void

extension BuildSite {
    /// Map a corpus reader into the essentials `BuildInputs`.
    ///
    /// GAP (homepage parity, later slice): the JS `buildHomepageProps` drops
    /// roots whose only page is the root itself and injects synthetic Fonts/
    /// Symbols "extras" into the Design kind (`buildHomepageExtras`). This passes
    /// every root through and emits no extras — the index roster is complete but
    /// not yet byte-identical to the JS homepage; the S3/corpus gate will flag it.
    public static func collectInputs<R: CorpusReader>(from reader: R, version: String? = nil) -> BuildInputs {
        let roots = reader.corpusRoots()
        let frameworks = roots.map {
            IndexFramework(kind: $0.kind, slug: $0.slug, displayName: $0.displayName, docCount: $0.documentCount)
        }
        let meta = roots.map {
            FrameworkMeta(slug: $0.slug, displayName: $0.displayName, kind: $0.kind, documentCount: $0.documentCount)
        }
        let total = roots.reduce(0) { $0 + $1.documentCount }
        return BuildInputs(
            indexFrameworks: frameworks, indexExtras: [], fontFamilies: reader.fontFamilies(),
            symbolTotals: reader.symbolTotals(), frameworkMeta: meta, version: version, totalDocuments: total)
    }

    /// Collect → plan → ensure dirs → write the essentials artifact tree. I/O is
    /// injected (`ensureDir`/`write`) so this stays Foundation-free. Returns the
    /// `BuildResult` (so the caller can log the stub ledger).
    @discardableResult
    public static func writeEssentials<R: CorpusReader>(
        config: SiteConfig, reader: R, version: String? = nil,
        ensureDir: (String) throws -> Void, write: ArtifactSink
    ) rethrows -> BuildResult {
        let inputs = collectInputs(from: reader, version: version)
        let result = planEssentials(config: config, inputs: inputs)
        for dir in result.dirs { try ensureDir(dir) }
        for artifact in result.artifacts { try write(artifact) }
        return result
    }
}
