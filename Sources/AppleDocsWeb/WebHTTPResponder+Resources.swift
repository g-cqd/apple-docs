import AemiHTTP
import AppleDocsCommands
import AppleDocsOutput

/// Non-HTML resources: bundled assets, sandboxed SF Symbol SVGs, and sitemaps.
extension WebHTTPResponder {
    /// CSP for standalone SVG documents: no script, no subresources, inline styles only.
    static let svgContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

    /// Serves `path` when it names a resource; `nil` hands the request to the page router.
    func handleResource(path: String) async -> ServerResponse? {
        if path.hasPrefix("/assets/") {
            let name = String(path.dropFirst("/assets/".count))
            guard let asset = WebAssetCatalog.asset(named: name) else { return .status(.notFound) }
            return response(asset.bytes, contentType: asset.contentType)
        }
        if path.hasPrefix("/symbols/"), path.hasSuffix(".svg") {
            return await symbolSVG(path: path)
        }
        if path == "/sitemap.xml" || path.hasPrefix("/sitemaps/") {
            return await sitemap(path: path)
        }
        return nil
    }

    private func symbolSVG(path: String) async -> ServerResponse {
        let parts = path.dropFirst("/symbols/".count).dropLast(".svg".count).split(separator: "/")
        guard parts.count == 2, parts[0] == "public" || parts[0] == "private",
            AssetRenderService.isValidSymbolName(String(parts[1]))
        else { return .status(.notFound) }
        do {
            let svg = try AssetRenderService.renderSFSymbolSVG(
                name: String(parts[1]),
                scope: String(parts[0]),
                size: 64,
                resourcesDirectory: reader.resourcesDirectory
            )
            return response(
                Array(svg.utf8),
                contentType: "image/svg+xml",
                extraHeaders: [(.contentSecurityPolicy, Self.svgContentSecurityPolicy)]
            )
        } catch {
            return .status(.notFound)
        }
    }

    private func sitemap(path: String) async -> ServerResponse {
        do {
            let slugs = try await reader.withStore { store in
                try CorpusQueryService.listFrameworks(on: store).map(\.slug)
            }
            let xml: String
            if path == "/sitemap.xml" {
                xml = WebSitemap.indexXML(baseURL: site.baseURL, frameworkSlugs: slugs)
            } else {
                let stem = String(path.dropFirst("/sitemaps/".count))
                guard stem.hasSuffix(".xml") else { return .status(.notFound) }
                let slug = String(stem.dropLast(".xml".count))
                if slug == WebSitemap.rootSitemapSlug {
                    xml = WebSitemap.urlSetXML(baseURL: site.baseURL, paths: WebSitemap.rootPaths)
                } else {
                    guard WebSitemap.isValidSlug(slug), slugs.contains(slug) else { return .status(.notFound) }
                    let keys = try await reader.withConnection { connection in
                        try CorpusQueryService.documentKeys(
                            framework: slug,
                            limit: WebSitemap.maxURLsPerSitemap - 1,
                            on: connection
                        )
                    }
                    let paths = (["/doc/\(slug)"] + keys.filter { $0 != slug }.map { WebDocPath.href($0) })
                    xml = WebSitemap.urlSetXML(baseURL: site.baseURL, paths: paths)
                }
            }
            return response(Array(xml.utf8), contentType: "application/xml; charset=utf-8")
        } catch {
            return .status(.internalServerError)
        }
    }
}
