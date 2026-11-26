import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsStorage

extension StaticSiteBuilder {
    /// Writes everything that is not a document page: landing/search/symbols/fonts/404 pages, assets,
    /// sitemaps, discovery files, `api/frameworks.json`, and the export marker.
    static func writeSiteFiles(
        plan: ExportPlan,
        exportedKeys: [String],
        databasePath: String,
        output: StaticSiteOutput,
        options: Options
    ) throws {
        let base = options.site.baseURL
        func write(_ text: String, _ path: String) throws { try output.write(Array(text.utf8), to: path) }
        func page(_ html: String, _ path: String) throws { try output.writeHTML(html, to: path) }

        try page(WebHTMLRenderer.renderIndexPage(frameworks: plan.frameworks), "index.html")
        try page(WebHTMLRenderer.renderNotFoundPage(path: "this address"), "404.html")
        try page(WebHTMLRenderer.renderStaticSearchPage(indexPath: "/search/title-index.json"), "search/index.html")
        try write(
            try StaticSearchIndex.build(keys: exportedKeys, databasePath: databasePath),
            "search/title-index.json"
        )
        for (name, asset) in WebAssetCatalog.assets { try output.write(asset.bytes, to: "assets/\(name)") }
        try write("User-agent: *\nAllow: /\nSitemap: \(base)/sitemap.xml\n", "robots.txt")
        try write("Contact: https://github.com/g-cqd/apple-docs/security/advisories\n", ".well-known/security.txt")
        try write(try PublicProjection.encodeJSON(plan.frameworks, pretty: true), "api/frameworks.json")

        var byFramework: [String: [String]] = [:]
        for key in exportedKeys {
            byFramework[key.split(separator: "/").first.map(String.init) ?? key, default: []].append(key)
        }
        let slugs = byFramework.keys.filter(WebSitemap.isValidSlug).sorted()
        try write(WebSitemap.indexXML(baseURL: base, frameworkSlugs: slugs), "sitemap.xml")
        try write(
            WebSitemap.urlSetXML(baseURL: base, paths: WebSitemap.rootPaths),
            "sitemaps/\(WebSitemap.rootSitemapSlug).xml"
        )
        for slug in slugs {
            let paths = (byFramework[slug] ?? []).map { "/doc/\(WebDocPath.safeKey($0))" }
            try write(WebSitemap.urlSetXML(baseURL: base, paths: paths), "sitemaps/\(slug).xml")
        }
        try writeAssetPages(databasePath: databasePath, output: output, resourcesDirectory: options.resourcesDirectory)
        try write("apple-docs static export\n", markerFileName)
    }

    private static func writeAssetPages(
        databasePath: String,
        output: StaticSiteOutput,
        resourcesDirectory: String?
    ) throws {
        let store = try CorpusStore(path: databasePath, options: .readOnly)
        defer { store.close() }
        let symbols = try AssetQueryService.searchSFSymbols(query: "", limit: 300, on: store.connection)
        let families = try AssetQueryService.listAppleFonts(on: store.connection)
        let resources = resourcesDirectory ?? CorpusPaths.defaultResourcesDirectory()
        var rendered: [PublicSFSymbol] = []
        for symbol in symbols {
            guard
                let svg = try? AssetRenderService.renderSFSymbolSVG(
                    name: symbol.name,
                    scope: symbol.scope,
                    size: 64,
                    resourcesDirectory: resources
                )
            else { continue }
            try output.write(Array(svg.utf8), to: "symbols/\(symbol.scope)/\(symbol.name).svg")
            rendered.append(symbol)
        }
        let symbolsPage = WebHTMLRenderer.renderSymbolsPage(query: "", scope: "public", symbols: rendered)
        try output.writeHTML(symbolsPage, to: "symbols/index.html")
        try output.writeHTML(WebHTMLRenderer.renderFontsPage(families: families), to: "fonts/index.html")
    }
}
