// The static-site build orchestrator — the PURE planner behind `src/web/build.js`'s
// `buildStaticSite`. Given corpus-derived inputs it returns the artifact tree
// (path → bytes) to write; the I/O driver (`ad-cli web build`) enumerates the corpus
// into the reader, calls this, and writes the artifacts. Keeping the planner I/O-free
// makes it testable without a DB or filesystem.
//
// The full pipeline is ported and wired. This module plans the site essentials
// (landing pages, discovery files, per-framework metadata, manifest); its siblings
// plan the assets pipeline (Assets.swift), search artifacts (SearchArtifacts.swift),
// sitemaps (Sitemaps.swift), and the per-document + framework render loop
// (WebBuildFull.swift / DocPage.swift / FrameworkPage.swift, with shiki highlighting
// via the ad-cli coprocess seam). The only build.js feature with no native twin is
// multi-process worker fan-out (a throughput knob); `BuildResult.stubs` therefore
// carries only the intentional `--skip-docs` note.

public import ADJSONCore

/// One file the build emits, path relative to the build root.
public struct Artifact: Sendable {
    public let path: String
    public let bytes: [UInt8]
    public init(path: String, bytes: [UInt8]) {
        self.path = path
        self.bytes = bytes
    }
    public init(path: String, text: String) {
        self.path = path
        self.bytes = Array(text.utf8)
    }
}

/// Per-framework metadata row (`data/frameworks/<slug>.json`).
public struct FrameworkMeta: Sendable {
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

/// Corpus-derived inputs for the essentials build. The driver assembles these
/// from ADStorage (mirroring the homepage/fonts/symbols view-models).
public struct BuildInputs: Sendable {
    public var indexFrameworks: [IndexFramework]
    public var indexExtras: [(kind: String, items: [IndexFramework])]
    public var fontFamilies: JSON?
    public var symbolTotals: [(scope: String, count: Int)]
    public var frameworkMeta: [FrameworkMeta]
    public var version: String?
    /// Manifest `totalDocuments` / `totalFrameworks` — RENDERED-page counts
    /// (`counters.pagesBuilt+pagesSkipped` / `frameworksBuilt` in build.js), so
    /// `--skip-docs` reports 0/0 even though the corpus is non-empty. (The
    /// per-framework metadata `documentCount` is separate, on `frameworkMeta`.)
    public var totalDocuments: Int
    public var totalFrameworks: Int
    /// generateSearchArtifacts' counts for `manifest.searchArtifacts`
    /// (JSON `null` until the S3 step ran).
    public var searchArtifacts: SearchArtifactsStats?

    public init(
        indexFrameworks: [IndexFramework] = [],
        indexExtras: [(kind: String, items: [IndexFramework])] = [],
        fontFamilies: JSON? = nil, symbolTotals: [(scope: String, count: Int)] = [],
        frameworkMeta: [FrameworkMeta] = [], version: String? = nil, totalDocuments: Int = 0,
        totalFrameworks: Int = 0, searchArtifacts: SearchArtifactsStats? = nil
    ) {
        self.indexFrameworks = indexFrameworks
        self.indexExtras = indexExtras
        self.fontFamilies = fontFamilies
        self.symbolTotals = symbolTotals
        self.frameworkMeta = frameworkMeta
        self.version = version
        self.totalDocuments = totalDocuments
        self.totalFrameworks = totalFrameworks
        self.searchArtifacts = searchArtifacts
    }
}

/// The planner's output: the artifacts to write, the directories to ensure, and
/// the steps still stubbed (logged by the driver so a partial build never reads
/// as complete).
public struct BuildResult: Sendable {
    public let dirs: [String]
    public let artifacts: [Artifact]
    public let stubs: [String]
    /// Render-loop counters (build.js `counters` — the checkpoint's
    /// pages_built/pages_skipped and the manifest totals' inputs).
    public let pagesBuilt: Int
    public let pagesSkipped: Int
    public let frameworksBuilt: Int

    init(
        dirs: [String], artifacts: [Artifact], stubs: [String], pagesBuilt: Int = 0,
        pagesSkipped: Int = 0, frameworksBuilt: Int = 0
    ) {
        self.dirs = dirs
        self.artifacts = artifacts
        self.stubs = stubs
        self.pagesBuilt = pagesBuilt
        self.pagesSkipped = pagesSkipped
        self.frameworksBuilt = frameworksBuilt
    }
}

public enum BuildSite {
    /// The directory skeleton (build.js step 1).
    public static let directories = [
        "assets", "docs", "data/search", "data/frameworks", "worker", "search", "fonts", "symbols",
        "api/fonts", ".well-known/mcp"
    ]

    /// The not-yet-ported steps, surfaced in every result so a partial build
    /// never reads as complete. WS-C is fully landed (S6 assets + faces.css,
    /// S3 search artifacts, S4 sitemaps, S5 doc loop + shiki coprocess) — only
    /// the essentials-only mode still stubs the doc loop.
    static let pendingSteps = [
        "docs/* document pages + framework listing pages [--skip-docs]"
    ]

    /// Plan the site-essentials artifacts (the build.js `--skip-docs` surface:
    /// landing pages + discovery + per-framework metadata + manifest). Pure.
    public static func planEssentials(config: SiteConfig, inputs: BuildInputs) -> BuildResult {
        var artifacts: [Artifact] = []

        // 4. Landing pages.
        artifacts.append(
            Artifact(
                path: "index.html",
                text: LandingPages.renderIndexPage(inputs.indexFrameworks, config, extras: inputs.indexExtras)))
        artifacts.append(Artifact(path: "search/index.html", text: LandingPages.renderSearchPage(config)))
        artifacts.append(
            Artifact(
                path: "fonts/index.html",
                text: LandingPages.renderFontsPage(config, families: inputs.fontFamilies)))
        // External @font-face sheet the /fonts page links — build.js writes it
        // right after the fonts page, from the same families payload, with the
        // `${baseUrl || ''}/api/fonts/file/<encodeURIComponent(id)>` src URLs.
        artifacts.append(
            Artifact(
                path: "api/fonts/faces.css",
                text: FontFaces.buildFontFaceCss(
                    inputs.fontFamilies, fileUrl: FontFaces.buildFileUrl(baseUrl: config.baseUrl))))
        artifacts.append(
            Artifact(
                path: "symbols/index.html",
                text: LandingPages.renderSymbolsPage(config, totals: inputs.symbolTotals)))
        artifacts.append(Artifact(path: "404.html", text: LandingPages.renderNotFoundPage(config)))

        // Discovery files.
        artifacts.append(Artifact(path: "robots.txt", text: Discovery.buildRobotsTxt(config)))
        artifacts.append(Artifact(path: "opensearch.xml", text: Discovery.buildOpenSearchXml(config)))
        artifacts.append(
            Artifact(
                path: ".well-known/api-catalog", text: Discovery.buildApiCatalog(config).serializedPretty(2)))
        artifacts.append(
            Artifact(
                path: ".well-known/mcp/server-card.json",
                text: Discovery.buildMcpServerCard(config, version: inputs.version).serializedPretty(2)))
        artifacts.append(Artifact(path: "_headers", text: Discovery.buildHeadersFile(config)))

        // 8. Per-framework metadata (compact JSON, like build.js).
        for meta in inputs.frameworkMeta {
            let json =
                JsonLd.object([
                    ("slug", .string(meta.slug)),
                    ("displayName", meta.displayName.map { JsonLd.string($0) } ?? .null),
                    ("kind", meta.kind.map { JsonLd.string($0) } ?? .null),
                    ("documentCount", .int(meta.documentCount))
                ])
                .serialized()
            artifacts.append(Artifact(path: "data/frameworks/\(meta.slug).json", text: json))
        }

        // 9. Manifest (pretty; written LAST in build.js — `writeAll` re-emits
        // it after the render loop with the real totals).
        artifacts.append(planManifest(config: config, inputs: inputs))

        return BuildResult(dirs: directories, artifacts: artifacts, stubs: pendingSteps)
    }

    /// build.js step 9 — the manifest artifact. `searchArtifacts` =
    /// generateSearchArtifacts' `{ titleCount, aliasCount, shardCount }` return
    /// (literal key order), JSON null when the S3 step didn't run;
    /// totalDocuments / totalFrameworks are the RENDERED counts.
    public static func planManifest(config: SiteConfig, inputs: BuildInputs) -> Artifact {
        let searchStats: JsonLd =
            inputs.searchArtifacts.map { stats in
                .object([
                    ("titleCount", .int(stats.titleCount)),
                    ("aliasCount", .int(stats.aliasCount)),
                    ("shardCount", .int(stats.shardCount))
                ])
            } ?? .null
        let manifest =
            JsonLd.object([
                ("version", .int(1)),
                ("siteName", .string(config.siteName)),
                ("buildDate", config.buildDate.map { JsonLd.string($0) } ?? .null),
                ("baseUrl", .string(config.baseUrl)),
                ("totalDocuments", .int(inputs.totalDocuments)),
                ("totalFrameworks", .int(inputs.totalFrameworks)),
                ("searchArtifacts", searchStats)
            ])
            .serializedPretty(2)
        return Artifact(path: "manifest.json", text: manifest)
    }
}
