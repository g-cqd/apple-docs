// Build-time site configuration the page templates close over. Mirrors the
// `siteConfig` shape `src/web/context.js` assembles (the fields the templates
// read). Grows as more templates land.

public struct SiteConfig: Sendable {
    public let baseUrl: String
    public let siteName: String
    /// Cache-busting asset version (`?v=…`); nil/empty → no query.
    public let assetVersion: String?
    /// Static build (bundled JS) vs dev server (individual script tags).
    public let bundled: Bool
    public let buildDate: String?
    public let snapshotTag: String?
    public let buildMacos: String?
    public let commitHash: String?

    public init(
        baseUrl: String = "", siteName: String = "Apple Developer Docs", assetVersion: String? = nil,
        bundled: Bool = false, buildDate: String? = nil, snapshotTag: String? = nil,
        buildMacos: String? = nil, commitHash: String? = nil
    ) {
        self.baseUrl = baseUrl
        self.siteName = siteName
        self.assetVersion = assetVersion
        self.bundled = bundled
        self.buildDate = buildDate
        self.snapshotTag = snapshotTag
        self.buildMacos = buildMacos
        self.commitHash = commitHash
    }
}
