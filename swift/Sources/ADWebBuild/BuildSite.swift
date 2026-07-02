// The static-site build orchestrator — skeleton port of `src/web/build.js`'s
// 13-step `buildStaticSite`. This is the PURE planner: given corpus-derived
// inputs it returns the artifact tree (path → bytes) to write, plus the explicit
// list of not-yet-ported steps. The I/O driver (`ad-cli web build`) enumerates
// the corpus into `BuildInputs`, calls this, and writes the artifacts; keeping
// the planner I/O-free makes it testable without a DB or filesystem.
//
// Implemented here: the site-essentials artifacts (build.js steps 1/4/8/9 + the
// discovery writes) — landing pages, discovery files, per-framework metadata,
// manifest. Stubs (each surfaced in `BuildResult.stubs`, fixed by later slices):
//   - assets pipeline (CSS minify / JS bundle / public copy) ........ S6
//   - api/fonts/faces.css (font-face sheet) ......................... font-faces
//   - data/search/* search artifacts ............................... S3
//   - sitemap.xml(.gz) ............................................. S3 + S4 gzip
//   - docs/* document pages + framework listing pages .............. S5 loop
//   - shiki highlighting (NoopHighlighter until then) .............. S5

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

    public init(
        indexFrameworks: [IndexFramework] = [],
        indexExtras: [(kind: String, items: [IndexFramework])] = [],
        fontFamilies: JSON? = nil, symbolTotals: [(scope: String, count: Int)] = [],
        frameworkMeta: [FrameworkMeta] = [], version: String? = nil, totalDocuments: Int = 0,
        totalFrameworks: Int = 0
    ) {
        self.indexFrameworks = indexFrameworks
        self.indexExtras = indexExtras
        self.fontFamilies = fontFamilies
        self.symbolTotals = symbolTotals
        self.frameworkMeta = frameworkMeta
        self.version = version
        self.totalDocuments = totalDocuments
        self.totalFrameworks = totalFrameworks
    }
}

/// The planner's output: the artifacts to write, the directories to ensure, and
/// the steps still stubbed (logged by the driver so a partial build never reads
/// as complete).
public struct BuildResult: Sendable {
    public let dirs: [String]
    public let artifacts: [Artifact]
    public let stubs: [String]
}

public enum BuildSite {
    /// The directory skeleton (build.js step 1).
    public static let directories = [
        "assets", "docs", "data/search", "data/frameworks", "worker", "search", "fonts", "symbols",
        "api/fonts", ".well-known/mcp",
    ]

    /// The not-yet-ported steps, surfaced in every result so the driver can log
    /// what a "successful" essentials build still omits. (S6 assets +
    /// api/fonts/faces.css shipped: `planAssets` + the faces.css artifact below.)
    static let pendingSteps = [
        "data/search/* search artifacts [S3]",
        "sitemap.xml(.gz) [S3 + S4 gzip]",
        "docs/* document pages + framework listing pages [S5 render loop]",
        "shiki code highlighting (NoopHighlighter until then) [S5]",
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
            let json = JsonLd.object([
                ("slug", .string(meta.slug)),
                ("displayName", meta.displayName.map { JsonLd.string($0) } ?? .null),
                ("kind", meta.kind.map { JsonLd.string($0) } ?? .null),
                ("documentCount", .int(meta.documentCount)),
            ]).serialized()
            artifacts.append(Artifact(path: "data/frameworks/\(meta.slug).json", text: json))
        }

        // 9. Manifest (pretty, searchArtifacts stubbed null until S3).
        let manifest = JsonLd.object([
            ("version", .int(1)),
            ("siteName", .string(config.siteName)),
            ("buildDate", config.buildDate.map { JsonLd.string($0) } ?? .null),
            ("baseUrl", .string(config.baseUrl)),
            ("totalDocuments", .int(inputs.totalDocuments)),
            ("totalFrameworks", .int(inputs.totalFrameworks)),
            ("searchArtifacts", .null),
        ]).serializedPretty(2)
        artifacts.append(Artifact(path: "manifest.json", text: manifest))

        return BuildResult(dirs: directories, artifacts: artifacts, stubs: pendingSteps)
    }
}
