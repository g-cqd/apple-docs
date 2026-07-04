import Testing

@testable import ADWebBuild

// Byte-exact against src/web/discovery.js (the static build writes api-catalog +
// mcp-card as `JSON.stringify(obj, null, 2)`; robots/opensearch/_headers raw).

private let dCfg = SiteConfig(baseUrl: "https://x.test", siteName: "Docs")
private let dEmpty = SiteConfig(baseUrl: "")
private let dCustom = SiteConfig(
    baseUrl: "https://x.test", siteName: "Apple & Co <Docs>",
    contentSignal: "search=yes, ai-train=no", searchShortName: "SuperLongSearchName")

@Test func robotsTxtByteExact() {
    let actual = Discovery.buildRobotsTxt(dCfg)
    let expected =
        "# As a condition of accessing this website, you agree to abide by the following\n# content signals:\n\n# (a)  If a content-signal = yes, you may collect content for the corresponding\n#      use.\n# (b)  If a content-signal = no, you may not collect content for the\n#      corresponding use.\n# (c)  If the website operator does not include a content signal for a\n#      corresponding use, the website operator neither grants nor restricts\n#      permission via content signal with respect to the corresponding use.\n\n# The content signals and their meanings are:\n\n# search:   building a search index and providing search results (e.g., returning\n#           hyperlinks and short excerpts from your website's contents). Search does not\n#           include providing AI-generated search summaries.\n# ai-input: inputting content into one or more AI models (e.g., retrieval\n#           augmented generation, grounding, or other real-time taking of content for\n#           generative AI search answers).\n# ai-train: training or fine-tuning AI models.\n\n# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF\n# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON COPYRIGHT\n# AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.\n\nUser-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /\nDisallow: /api/\n\n# The same content signals are also delivered as a Content-Signal HTTP\n# response header so spec-aware crawlers can read them per-response.\n\nSitemap: https://x.test/sitemap.xml\n"
    #expect(actual == expected)
}

@Test func robotsTxtEmptyOriginByteExact() {
    let actual = Discovery.buildRobotsTxt(dEmpty)
    let expected =
        "# As a condition of accessing this website, you agree to abide by the following\n# content signals:\n\n# (a)  If a content-signal = yes, you may collect content for the corresponding\n#      use.\n# (b)  If a content-signal = no, you may not collect content for the\n#      corresponding use.\n# (c)  If the website operator does not include a content signal for a\n#      corresponding use, the website operator neither grants nor restricts\n#      permission via content signal with respect to the corresponding use.\n\n# The content signals and their meanings are:\n\n# search:   building a search index and providing search results (e.g., returning\n#           hyperlinks and short excerpts from your website's contents). Search does not\n#           include providing AI-generated search summaries.\n# ai-input: inputting content into one or more AI models (e.g., retrieval\n#           augmented generation, grounding, or other real-time taking of content for\n#           generative AI search answers).\n# ai-train: training or fine-tuning AI models.\n\n# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF\n# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON COPYRIGHT\n# AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.\n\nUser-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /\nDisallow: /api/\n\n# The same content signals are also delivered as a Content-Signal HTTP\n# response header so spec-aware crawlers can read them per-response.\n\nSitemap: /sitemap.xml\n"
    #expect(actual == expected)
}

@Test func robotsTxtCustomSignalByteExact() {
    let actual = Discovery.buildRobotsTxt(dCustom)
    #expect(actual.contains("\nContent-Signal: search=yes, ai-train=no\n"))
    #expect(actual.hasSuffix("\nSitemap: https://x.test/sitemap.xml\n"))
}

@Test func openSearchXmlByteExact() {
    let actual = Discovery.buildOpenSearchXml(dCfg)
    let expected =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<OpenSearchDescription xmlns=\"http://a9.com/-/spec/opensearch/1.1/\">\n  <ShortName>Apple Docs</ShortName>\n  <LongName>Docs</LongName>\n  <Description>Search Docs</Description>\n  <InputEncoding>UTF-8</InputEncoding>\n  <Url type=\"text/html\" method=\"get\" template=\"https://x.test/search?q={searchTerms}\"/>\n  <Url type=\"application/opensearchdescription+xml\" rel=\"self\" template=\"https://x.test/opensearch.xml\"/>\n</OpenSearchDescription>\n"
    #expect(actual == expected)
}

@Test func openSearchXmlEscapedAndTruncatedByteExact() {
    let actual = Discovery.buildOpenSearchXml(dCustom)
    let expected =
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<OpenSearchDescription xmlns=\"http://a9.com/-/spec/opensearch/1.1/\">\n  <ShortName>SuperLongSearchN</ShortName>\n  <LongName>Apple &amp; Co &lt;Docs&gt;</LongName>\n  <Description>Search Apple &amp; Co &lt;Docs&gt;</Description>\n  <InputEncoding>UTF-8</InputEncoding>\n  <Url type=\"text/html\" method=\"get\" template=\"https://x.test/search?q={searchTerms}\"/>\n  <Url type=\"application/opensearchdescription+xml\" rel=\"self\" template=\"https://x.test/opensearch.xml\"/>\n</OpenSearchDescription>\n"
    #expect(actual == expected)
}

@Test func headersFileByteExact() {
    let actual = Discovery.buildHeadersFile(dCfg)
    let expected =
        "/*\n  Link: </sitemap.xml>; rel=\"sitemap\", </.well-known/api-catalog>; rel=\"api-catalog\", </docs/>; rel=\"service-doc\", </opensearch.xml>; rel=\"search\"\n  Vary: Accept\n  Content-Signal: search=yes, ai-input=yes, ai-train=yes\n\n/.well-known/api-catalog\n  Content-Type: application/linkset+json\n"
    #expect(actual == expected)
}

@Test func apiCatalogPrettyByteExact() {
    let actual = Discovery.buildApiCatalog(dCfg).serializedPretty(2)
    let expected =
        "{\n  \"linkset\": [\n    {\n      \"anchor\": \"https://x.test/\",\n      \"service-doc\": [\n        {\n          \"href\": \"https://x.test/docs/\",\n          \"title\": \"Apple Developer Docs\",\n          \"type\": \"text/html\"\n        }\n      ],\n      \"status\": [\n        {\n          \"href\": \"https://x.test/readyz\",\n          \"type\": \"application/json\"\n        }\n      ],\n      \"item\": [\n        {\n          \"href\": \"https://x.test/api/search\",\n          \"title\": \"Documentation search\",\n          \"type\": \"application/json\"\n        },\n        {\n          \"href\": \"https://x.test/api/filters\",\n          \"title\": \"Search filter facets\",\n          \"type\": \"application/json\"\n        },\n        {\n          \"href\": \"https://x.test/api/symbols/search\",\n          \"title\": \"SF Symbols search\",\n          \"type\": \"application/json\"\n        },\n        {\n          \"href\": \"https://x.test/api/fonts\",\n          \"title\": \"Apple fonts catalog\",\n          \"type\": \"application/json\"\n        },\n        {\n          \"href\": \"https://x.test/api/fonts/faces.css\",\n          \"title\": \"Apple fonts @font-face sheet\",\n          \"type\": \"text/css\"\n        }\n      ],\n      \"related\": [\n        {\n          \"href\": \"https://x.test/.well-known/mcp/server-card.json\",\n          \"title\": \"MCP Server Card\",\n          \"type\": \"application/json\"\n        }\n      ]\n    }\n  ]\n}"
    #expect(actual == expected)
}

@Test func apiCatalogEmptyOriginByteExact() {
    let actual = Discovery.buildApiCatalog(dEmpty).serializedPretty(2)
    let expected =
        "{\n  \"linkset\": [\n    {\n      \"anchor\": \"/\",\n      \"service-doc\": [\n        {\n          \"href\": \"/docs/\",\n          \"title\": \"Apple Developer Docs\",\n          \"type\": \"text/html\"\n        }\n      ],\n      \"status\": [\n        {\n          \"href\": \"/readyz\",\n          \"type\": \"application/json\"\n        }\n      ],\n      \"item\": [\n        {\n          \"href\": \"/api/search\",\n          \"title\": \"Documentation search\",\n          \"type\": \"application/json\"\n        },\n        {\n          \"href\": \"/api/filters\",\n          \"title\": \"Search filter facets\",\n          \"type\": \"application/json\"\n        },\n        {\n          \"href\": \"/api/symbols/search\",\n          \"title\": \"SF Symbols search\",\n          \"type\": \"application/json\"\n        },\n        {\n          \"href\": \"/api/fonts\",\n          \"title\": \"Apple fonts catalog\",\n          \"type\": \"application/json\"\n        },\n        {\n          \"href\": \"/api/fonts/faces.css\",\n          \"title\": \"Apple fonts @font-face sheet\",\n          \"type\": \"text/css\"\n        }\n      ],\n      \"related\": [\n        {\n          \"href\": \"/.well-known/mcp/server-card.json\",\n          \"title\": \"MCP Server Card\",\n          \"type\": \"application/json\"\n        }\n      ]\n    }\n  ]\n}"
    #expect(actual == expected)
}

@Test func mcpServerCardPrettyByteExact() {
    let actual = Discovery.buildMcpServerCard(dCfg, version: "1.2.3").serializedPretty(2)
    let expected =
        "{\n  \"serverInfo\": {\n    \"name\": \"apple-docs\",\n    \"version\": \"1.2.3\"\n  },\n  \"description\": \"Search and read Apple developer documentation offline: DocC API reference, HIG, App Store Review Guidelines, Swift Evolution, WWDC sessions, sample code, SF Symbols, and Apple fonts. Read-only tools, token-lean definitions.\",\n  \"transport\": {\n    \"type\": \"streamable-http\",\n    \"endpoint\": \"https://x.test/mcp\"\n  },\n  \"capabilities\": [\n    \"tools\",\n    \"resources\"\n  ],\n  \"endpoints\": {\n    \"health\": \"https://x.test/healthz\",\n    \"ready\": \"https://x.test/readyz\"\n  },\n  \"tools\": [\n    \"search_docs\",\n    \"read_doc\",\n    \"list_frameworks\",\n    \"browse\",\n    \"list_taxonomy\",\n    \"search_sf_symbols\",\n    \"list_apple_fonts\",\n    \"render_sf_symbol\",\n    \"render_font_text\"\n  ],\n  \"resources\": [\n    \"apple-docs://doc/{+key}\",\n    \"apple-docs://framework/{slug}\",\n    \"apple-docs://sf-symbol/{scope}/{name}.{format}\",\n    \"apple-docs://font/{id}\"\n  ]\n}"
    #expect(actual == expected)
}

@Test func mcpServerCardNoVersionOmitsKey() {
    let actual = Discovery.buildMcpServerCard(dCfg).serializedPretty(2)
    let expected =
        "{\n  \"serverInfo\": {\n    \"name\": \"apple-docs\"\n  },\n  \"description\": \"Search and read Apple developer documentation offline: DocC API reference, HIG, App Store Review Guidelines, Swift Evolution, WWDC sessions, sample code, SF Symbols, and Apple fonts. Read-only tools, token-lean definitions.\",\n  \"transport\": {\n    \"type\": \"streamable-http\",\n    \"endpoint\": \"https://x.test/mcp\"\n  },\n  \"capabilities\": [\n    \"tools\",\n    \"resources\"\n  ],\n  \"endpoints\": {\n    \"health\": \"https://x.test/healthz\",\n    \"ready\": \"https://x.test/readyz\"\n  },\n  \"tools\": [\n    \"search_docs\",\n    \"read_doc\",\n    \"list_frameworks\",\n    \"browse\",\n    \"list_taxonomy\",\n    \"search_sf_symbols\",\n    \"list_apple_fonts\",\n    \"render_sf_symbol\",\n    \"render_font_text\"\n  ],\n  \"resources\": [\n    \"apple-docs://doc/{+key}\",\n    \"apple-docs://framework/{slug}\",\n    \"apple-docs://sf-symbol/{scope}/{name}.{format}\",\n    \"apple-docs://font/{id}\"\n  ]\n}"
    #expect(actual == expected)
}

@Test func discoveryConstants() {
    #expect(
        Discovery.discoveryLinks
            == "</sitemap.xml>; rel=\"sitemap\", </.well-known/api-catalog>; rel=\"api-catalog\", </docs/>; rel=\"service-doc\", </opensearch.xml>; rel=\"search\""
    )
    #expect(Discovery.defaultContentSignal == "search=yes, ai-input=yes, ai-train=yes")
}
