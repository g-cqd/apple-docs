// siteConfig + the agent-discovery builders (RFC 0001 P6 web slice). Ports
// src/web/discovery.js byte-for-byte: robots.txt, opensearch.xml, the RFC 9727
// api-catalog linkset, and the MCP server card. Every builder is a pure function
// of siteConfig (no DB), so it serves on the event loop (no offload). siteConfig
// is plumbed from ad-server flags (Main.swift); defaults mirror the JS defaults
// (src/web/context.js:71-84 + discovery.js constants).

import ADJSON

struct SiteConfig: Sendable {
  var baseUrl: String = ""
  var siteName: String = "Apple Developer Docs"
  var searchShortName: String = "Apple Docs"
  var contentSignal: String = "search=yes, ai-input=yes, ai-train=yes"
  var appVersion: String = "0.0.0"
}

/// Trim trailing slashes off the configured base URL (discovery.js originOf).
private func origin(_ baseUrl: String) -> String {
  var end = baseUrl.endIndex
  while end > baseUrl.startIndex, baseUrl[baseUrl.index(before: end)] == "/" {
    end = baseUrl.index(before: end)
  }
  return String(baseUrl[..<end])
}

/// Absolute URL when an origin is configured, else the bare path (discovery.js url()).
private func url(_ origin: String, _ path: String) -> String {
  origin.isEmpty ? path : origin + path
}

/// JS-order XML escape: & first, then < > " (discovery.js esc).
private func xmlEscape(_ s: String) -> String {
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

/// JS `String.prototype.slice(0, n)` — UTF-16 code units (identity for ASCII).
private func sliceUTF16(_ s: String, _ n: Int) -> String {
  String(decoding: Array(s.utf16.prefix(n)), as: UTF16.self)
}

private let mcpTools = [
  "search_docs", "read_doc", "list_frameworks", "browse", "list_taxonomy",
  "search_sf_symbols", "list_apple_fonts", "render_sf_symbol", "render_font_text",
]
private let mcpResources = [
  "apple-docs://doc/{+key}", "apple-docs://framework/{slug}",
  "apple-docs://sf-symbol/{scope}/{name}.{format}", "apple-docs://font/{id}",
]

enum Discovery {
  /// robots.txt — content-signal preamble + crawl policy + sitemap pointer.
  static func robotsTxt(_ cfg: SiteConfig) -> [UInt8] {
    let signal = cfg.contentSignal
    let sitemap = url(origin(cfg.baseUrl), "/sitemap.xml")
    let body = """
# As a condition of accessing this website, you agree to abide by the following
# content signals:

# (a)  If a content-signal = yes, you may collect content for the corresponding
#      use.
# (b)  If a content-signal = no, you may not collect content for the
#      corresponding use.
# (c)  If the website operator does not include a content signal for a
#      corresponding use, the website operator neither grants nor restricts
#      permission via content signal with respect to the corresponding use.

# The content signals and their meanings are:

# search:   building a search index and providing search results (e.g., returning
#           hyperlinks and short excerpts from your website's contents). Search does not
#           include providing AI-generated search summaries.
# ai-input: inputting content into one or more AI models (e.g., retrieval
#           augmented generation, grounding, or other real-time taking of content for
#           generative AI search answers).
# ai-train: training or fine-tuning AI models.

# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF
# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON COPYRIGHT
# AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.

User-agent: *
Content-Signal: \(signal)
Allow: /
Disallow: /api/

# The same content signals are also delivered as a Content-Signal HTTP
# response header so spec-aware crawlers can read them per-response.

Sitemap: \(sitemap)

"""
    return Array(body.utf8)
  }

  /// opensearch.xml — OpenSearch 1.1 description (ShortName capped at 16 UTF-16 units).
  static func openSearchXml(_ cfg: SiteConfig) -> [UInt8] {
    let o = origin(cfg.baseUrl)
    let longName = cfg.siteName.isEmpty ? "Apple Developer Docs" : cfg.siteName
    let shortName = sliceUTF16(cfg.searchShortName.isEmpty ? "Apple Docs" : cfg.searchShortName, 16)
    let body = """
<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>\(xmlEscape(shortName))</ShortName>
  <LongName>\(xmlEscape(longName))</LongName>
  <Description>\(xmlEscape("Search \(longName)"))</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="text/html" method="get" template="\(xmlEscape(url(o, "/search?q={searchTerms}")))"/>
  <Url type="application/opensearchdescription+xml" rel="self" template="\(xmlEscape(url(o, "/opensearch.xml")))"/>
</OpenSearchDescription>

"""
    return Array(body.utf8)
  }

  /// /.well-known/api-catalog — RFC 9727 linkset (RFC 9264 JSON).
  static func apiCatalog(_ cfg: SiteConfig) -> [UInt8] {
    let o = origin(cfg.baseUrl)
    func link(_ w: inout JSONStreamWriter, _ href: String, title: String?, type: String) {
      w.beginObject()
      w.key("href")
      w.string(href)
      if let title {
        w.key("title")
        w.string(title)
      }
      w.key("type")
      w.string(type)
      w.endObject()
    }
    var w = JSONStreamWriter(capacity: 1024)
    w.beginObject()
    w.key("linkset")
    w.beginArray()
    w.beginObject()
    w.key("anchor")
    w.string(url(o, "/"))
    w.key("service-doc")
    w.beginArray()
    link(&w, url(o, "/docs/"), title: "Apple Developer Docs", type: "text/html")
    w.endArray()
    w.key("status")
    w.beginArray()
    link(&w, url(o, "/readyz"), title: nil, type: "application/json")
    w.endArray()
    w.key("item")
    w.beginArray()
    link(&w, url(o, "/api/search"), title: "Documentation search", type: "application/json")
    link(&w, url(o, "/api/filters"), title: "Search filter facets", type: "application/json")
    link(&w, url(o, "/api/symbols/search"), title: "SF Symbols search", type: "application/json")
    link(&w, url(o, "/api/fonts"), title: "Apple fonts catalog", type: "application/json")
    link(&w, url(o, "/api/fonts/faces.css"), title: "Apple fonts @font-face sheet", type: "text/css")
    w.endArray()
    w.key("related")
    w.beginArray()
    link(
      &w, url(o, "/.well-known/mcp/server-card.json"), title: "MCP Server Card",
      type: "application/json")
    w.endArray()
    w.endObject()
    w.endArray()
    w.endObject()
    return w.finish()
  }

  /// /.well-known/mcp/server-card.json — MCP identity + tool/resource lists.
  static func mcpServerCard(_ cfg: SiteConfig) -> [UInt8] {
    let o = origin(cfg.baseUrl)
    var w = JSONStreamWriter(capacity: 1024)
    w.beginObject()
    w.key("serverInfo")
    w.beginObject()
    w.key("name")
    w.string("apple-docs")
    w.key("version")
    w.string(cfg.appVersion)
    w.endObject()
    w.key("description")
    w.string(
      "Search and read Apple developer documentation offline: DocC API reference, HIG, App Store Review Guidelines, Swift Evolution, WWDC sessions, sample code, SF Symbols, and Apple fonts. Read-only tools, token-lean definitions."
    )
    w.key("transport")
    w.beginObject()
    w.key("type")
    w.string("streamable-http")
    w.key("endpoint")
    w.string(url(o, "/mcp"))
    w.endObject()
    w.key("capabilities")
    w.beginArray()
    w.string("tools")
    w.string("resources")
    w.endArray()
    w.key("endpoints")
    w.beginObject()
    w.key("health")
    w.string(url(o, "/healthz"))
    w.key("ready")
    w.string(url(o, "/readyz"))
    w.endObject()
    w.key("tools")
    w.beginArray()
    for tool in mcpTools { w.string(tool) }
    w.endArray()
    w.key("resources")
    w.beginArray()
    for resource in mcpResources { w.string(resource) }
    w.endArray()
    w.endObject()
    return w.finish()
  }
}
