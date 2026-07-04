// Agent-discovery affordances — port of `src/web/discovery.js`. Pure functions
// of SiteConfig (the JS reads `process.env.APPLE_DOCS_CONTENT_SIGNAL` inside
// `contentSignal()`; here the context boundary folds that env into
// `config.contentSignal`, keeping these Foundation-free + I/O-free so the live
// server and the static build emit byte-identical metadata).

public enum Discovery {
    /// Standing Content-Signal stance (matches ops/caddy/Caddyfile.tpl).
    public static let defaultContentSignal = "search=yes, ai-input=yes, ai-train=yes"

    /// MCP tool names (src/mcp/tools/*).
    public static let mcpTools = [
        "search_docs", "read_doc", "list_frameworks", "browse", "list_taxonomy",
        "search_sf_symbols", "list_apple_fonts", "render_sf_symbol", "render_font_text"
    ]

    /// MCP resource templates (src/mcp/server/resources.js).
    public static let mcpResourceTemplates = [
        "apple-docs://doc/{+key}", "apple-docs://framework/{slug}",
        "apple-docs://sf-symbol/{scope}/{name}.{format}", "apple-docs://font/{id}"
    ]

    /// RFC 8288 `Link` header set advertised on every response.
    public static let discoveryLinks = [
        "</sitemap.xml>; rel=\"sitemap\"",
        "</.well-known/api-catalog>; rel=\"api-catalog\"",
        "</docs/>; rel=\"service-doc\"",
        "</opensearch.xml>; rel=\"search\""
    ]
    .joined(separator: ", ")

    /// Resolve the configured content-signal policy.
    public static func contentSignal(_ config: SiteConfig) -> String {
        if let cs = config.contentSignal, !cs.isEmpty { return cs }
        return defaultContentSignal
    }

    // MARK: - robots.txt

    public static func buildRobotsTxt(_ config: SiteConfig) -> String {
        let signal = contentSignal(config)
        let sitemap = url(originOf(config), "/sitemap.xml")
        return
            "# As a condition of accessing this website, you agree to abide by the following\n# content signals:\n\n# (a)  If a content-signal = yes, you may collect content for the corresponding\n#      use.\n# (b)  If a content-signal = no, you may not collect content for the\n#      corresponding use.\n# (c)  If the website operator does not include a content signal for a\n#      corresponding use, the website operator neither grants nor restricts\n#      permission via content signal with respect to the corresponding use.\n\n# The content signals and their meanings are:\n\n# search:   building a search index and providing search results (e.g., returning\n#           hyperlinks and short excerpts from your website's contents). Search does not\n#           include providing AI-generated search summaries.\n# ai-input: inputting content into one or more AI models (e.g., retrieval\n#           augmented generation, grounding, or other real-time taking of content for\n#           generative AI search answers).\n# ai-train: training or fine-tuning AI models.\n\n# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF\n# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON COPYRIGHT\n# AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.\n\nUser-agent: *\nContent-Signal: \(signal)\nAllow: /\nDisallow: /api/\n\n# The same content signals are also delivered as a Content-Signal HTTP\n# response header so spec-aware crawlers can read them per-response.\n\nSitemap: \(sitemap)\n"
    }

    // MARK: - opensearch.xml

    public static func buildOpenSearchXml(_ config: SiteConfig) -> String {
        let origin = originOf(config)
        let longName = config.siteName.isEmpty ? "Apple Developer Docs" : config.siteName
        let rawShort = (config.searchShortName?.isEmpty == false) ? config.searchShortName! : "Apple Docs"
        let shortName = String(decoding: Array(rawShort.utf16).prefix(16), as: UTF16.self)
        return
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<OpenSearchDescription xmlns=\"http://a9.com/-/spec/opensearch/1.1/\">\n  <ShortName>\(xmlEscape(shortName))</ShortName>\n  <LongName>\(xmlEscape(longName))</LongName>\n  <Description>\(xmlEscape("Search \(longName)"))</Description>\n  <InputEncoding>UTF-8</InputEncoding>\n  <Url type=\"text/html\" method=\"get\" template=\"\(xmlEscape(url(origin, "/search?q={searchTerms}")))\"/>\n  <Url type=\"application/opensearchdescription+xml\" rel=\"self\" template=\"\(xmlEscape(url(origin, "/opensearch.xml")))\"/>\n</OpenSearchDescription>\n"
    }

    // MARK: - _headers

    public static func buildHeadersFile(_ config: SiteConfig) -> String {
        "/*\n  Link: \(discoveryLinks)\n  Vary: Accept\n  Content-Signal: \(contentSignal(config))\n\n/.well-known/api-catalog\n  Content-Type: application/linkset+json\n"
    }

    // MARK: - api-catalog (RFC 9727 linkset / RFC 9264)

    /// The structured linkset. The build writes `.serializedPretty(2)` of it.
    /// (Internal: `JsonLd` is an ADWebBuild detail; the orchestrator serializes
    /// here. ad-server reuse, when it lands, gets a public String convenience.)
    static func buildApiCatalog(_ config: SiteConfig) -> JsonLd {
        let origin = originOf(config)
        func link(_ href: String, _ title: String?, _ type: String) -> JsonLd {
            var pairs: [(String, JsonLd)] = [("href", .string(href))]
            if let title { pairs.append(("title", .string(title))) }
            pairs.append(("type", .string(type)))
            return .object(pairs)
        }
        return .object([
            (
                "linkset",
                .array([
                    .object([
                        ("anchor", .string(url(origin, "/"))),
                        ("service-doc", .array([link(url(origin, "/docs/"), "Apple Developer Docs", "text/html")])),
                        ("status", .array([link(url(origin, "/readyz"), nil, "application/json")])),
                        (
                            "item",
                            .array([
                                link(url(origin, "/api/search"), "Documentation search", "application/json"),
                                link(url(origin, "/api/filters"), "Search filter facets", "application/json"),
                                link(url(origin, "/api/symbols/search"), "SF Symbols search", "application/json"),
                                link(url(origin, "/api/fonts"), "Apple fonts catalog", "application/json"),
                                link(url(origin, "/api/fonts/faces.css"), "Apple fonts @font-face sheet", "text/css")
                            ])
                        ),
                        (
                            "related",
                            .array([
                                link(
                                    url(origin, "/.well-known/mcp/server-card.json"), "MCP Server Card",
                                    "application/json")
                            ])
                        )
                    ])
                ])
            )
        ])
    }

    // MARK: - MCP server card

    /// The structured server card. The build writes `.serializedPretty(2)` of it.
    /// `version` nil → the `version` key is omitted (matches `JSON.stringify` of
    /// `{ version: undefined }`).
    static func buildMcpServerCard(_ config: SiteConfig, version: String? = nil) -> JsonLd {
        let origin = originOf(config)
        var serverInfo: [(String, JsonLd)] = [("name", .string("apple-docs"))]
        if let version { serverInfo.append(("version", .string(version))) }
        return .object([
            ("serverInfo", .object(serverInfo)),
            (
                "description",
                .string(
                    "Search and read Apple developer documentation offline: DocC API reference, HIG, App Store Review Guidelines, Swift Evolution, WWDC sessions, sample code, SF Symbols, and Apple fonts. Read-only tools, token-lean definitions."
                )
            ),
            (
                "transport",
                .object([("type", .string("streamable-http")), ("endpoint", .string(url(origin, "/mcp")))])
            ),
            ("capabilities", .array([.string("tools"), .string("resources")])),
            (
                "endpoints",
                .object([("health", .string(url(origin, "/healthz"))), ("ready", .string(url(origin, "/readyz")))])
            ),
            ("tools", .array(mcpTools.map { .string($0) })),
            ("resources", .array(mcpResourceTemplates.map { .string($0) }))
        ])
    }

    // MARK: - helpers

    /// `(baseUrl || '').replace(/\/+$/, '')`.
    private static func originOf(_ config: SiteConfig) -> String {
        var end = config.baseUrl.endIndex
        while end > config.baseUrl.startIndex, config.baseUrl[config.baseUrl.index(before: end)] == "/" {
            end = config.baseUrl.index(before: end)
        }
        return String(config.baseUrl[config.baseUrl.startIndex ..< end])
    }

    /// `origin ? \`${origin}${path}\` : path`.
    private static func url(_ origin: String, _ path: String) -> String {
        origin.isEmpty ? path : origin + path
    }

    /// `.replace(/&/,'&amp;').replace(/</,'&lt;').replace(/>/,'&gt;').replace(/"/,'&quot;')`.
    private static func xmlEscape(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for ch in s {
            switch ch {
                case "&": out += "&amp;"
                case "<": out += "&lt;"
                case ">": out += "&gt;"
                case "\"": out += "&quot;"
                default: out.append(ch)
            }
        }
        return out
    }
}
