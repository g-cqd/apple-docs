// The ad-server endpoint declarations (RFC 0005). This is the whole route surface,
// expressed in the ADServeDSL: each route is `GET(...)`/`route(.get, match:)` →
// `.storage`/`.cache`/`.respond { … }`. The engine applies the cross-cutting envelope
// (built below) to every response; routes only opt into cache/ETag. Business logic
// stays in WebRoutes/Discovery/Cascade — the declarations just wire path → logic.

import ADJSON
import ADSearchCascade
import ADServeCore
import ADServeDSL
import ADStorage
import HTTPTypes

/// The full route table, closing over the site config (discovery + tree hrefs).
func endpoints(config: SiteConfig) -> RouteTable {
  RouteTable {
    // Liveness — static, no storage, never cached.
    GET("/healthz").cache(.noStore)
      .respond { _ in .json(Array(#"{"ok":true,"service":"ad-server"}"#.utf8)) }

    // Lexical search cascade. `application/json` (no charset) + no cache, as Bun.
    GET("/search").storage
      .respond { ctx in
        .json(Cascade.search(ctx.connection, parseCascadeParams(ctx.target)), contentType: "application/json")
      }

    // Readiness — the DB probe; status carries ok/503, the route carries `no-store`.
    GET("/readyz").storage.cache(.noStore)
      .respond { ctx in WebRoutes.readyz(dbOk: ctx.connection.probe()) }

    // ---- /api ----
    GET("/api/filters").storage.cache(.apiCorpus)
      .respond { ctx in .json(WebRoutes.filters(ctx.connection)) }

    GET("/api/fonts").storage.etag
      .respond { ctx in .json(WebRoutes.fonts(ctx.connection)) }

    GET("/api/fonts/faces.css").storage.cache(.apiCorpus, etag: true)
      .respond { ctx in
        .text(WebRoutes.fontFacesCss(ctx.connection, baseUrl: config.baseUrl), contentType: "text/css; charset=utf-8")
      }

    GET("/api/symbols/index.json").storage.etag
      .respond { ctx in .json(WebRoutes.symbolsIndex(ctx.connection)) }

    GET("/api/symbols/search").storage.etag
      .respond { ctx in
        let query = parseQuery(ctx.target)
        return .json(
          WebRoutes.symbolsSearch(
            ctx.connection, query: query["q"] ?? "", scope: nonEmptyScope(query["scope"]),
            limit: clampSymbolLimit(query["limit"])))
      }

    // ---- /data/search ----
    GET("/data/search/search-manifest.json").storage.cache(.noCache, etag: true)
      .respond { ctx in .json(WebRoutes.searchManifest(ctx.connection)) }

    GET("/data/search/title-index.json").storage
      .respond { ctx in .json(WebRoutes.titleIndexBytes(ctx.connection)) }

    GET("/data/search/aliases.json").storage
      .respond { ctx in .json(WebRoutes.aliasMapBytes(ctx.connection)) }

    // ---- discovery (pure siteConfig, no storage) ----
    GET("/robots.txt").cache(.discovery, etag: true)
      .respond { _ in .text(Discovery.robotsTxt(config), contentType: "text/plain; charset=utf-8") }

    GET("/opensearch.xml").cache(.discovery, etag: true)
      .respond { _ in
        .text(Discovery.openSearchXml(config), contentType: "application/opensearchdescription+xml")
      }

    GET("/.well-known/api-catalog").cache(.discovery, etag: true)
      .respond { _ in .text(Discovery.apiCatalog(config), contentType: "application/linkset+json") }

    GET("/.well-known/mcp/server-card.json").cache(.discovery, etag: true)
      .respond { _ in .json(Discovery.mcpServerCard(config)) }

    // ---- pattern routes (typed matchers; irregular grammar → explicit matchers) ----
    route(.get, match: matchSymbolMetadataPath).storage.etag
      .respond { ctx, symbol in
        WebRoutes.symbolMetadata(ctx.connection, scope: symbol.scope, name: symbol.name)
          .map { ResponseContent.json($0) } ?? .notFound
      }

    route(.get, match: matchHashedSearchArtifact).storage.cache(.immutable, etag: true)
      .respond { ctx, base in
        .json(base == "title-index" ? WebRoutes.titleIndexBytes(ctx.connection) : WebRoutes.aliasMapBytes(ctx.connection))
      }

    route(.get, match: matchFrameworkTreePath).storage.cache(.immutable)
      .respond { ctx, slug in
        WebRoutes.frameworkTree(ctx.connection, slug: slug, baseUrl: config.baseUrl)
          .map { ResponseContent.text($0, contentType: "application/json; charset=utf-8") } ?? .notFound
      }
  }
}

// MARK: - The response envelope (constant headers on every response)

/// The cross-cutting header set: the security headers (src/web/context.js:231-239),
/// the RFC 8288 `Link` set (src/web/discovery.js), and `Vary: Accept`. Built once as
/// `HTTPFields` (RFC 0006 H1 — no `[(String,String)]` tuples) and applied by the engine.
func buildEnvelope() -> HTTPFields {
  // CSP (src/web/csp.js). DEVIATION (carried from the web slice): the 404-page inline
  // script hash is omitted — ad-server serves no inline scripts and CSP is inert on
  // JSON/text API responses.
  let csp =
    "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; "
    + "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; "
    + "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  let discoveryLinks =
    #"</sitemap.xml>; rel="sitemap", </.well-known/api-catalog>; rel="api-catalog", </docs/>; rel="service-doc", </opensearch.xml>; rel="search""#

  var fields = HTTPFields()
  fields[fieldName("x-content-type-options")] = "nosniff"
  fields[fieldName("x-frame-options")] = "DENY"
  fields[fieldName("referrer-policy")] = "strict-origin-when-cross-origin"
  fields[fieldName("permissions-policy")] = "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
  fields[fieldName("cross-origin-opener-policy")] = "same-origin"
  fields[fieldName("cross-origin-resource-policy")] = "same-origin"
  fields[fieldName("content-security-policy")] = csp
  fields[fieldName("link")] = discoveryLinks
  fields[fieldName("vary")] = "Accept"
  return fields
}

private func fieldName(_ name: String) -> HTTPField.Name { HTTPField.Name(name)! }

// MARK: - App cache presets + route param helpers

extension CachePolicy {
  /// Corpus-derived JSON (src/web/responses.js API_CORPUS_CACHE_CONTROL).
  static let apiCorpus = CachePolicy(cacheControl: "public, max-age=300, stale-while-revalidate=3600")
  /// Discovery endpoints (a pure function of siteConfig).
  static let discovery = CachePolicy(cacheControl: "public, max-age=3600")
}

/// `url.searchParams.get('scope') || undefined` — empty/absent → nil.
func nonEmptyScope(_ value: String?) -> String? {
  guard let value, !value.isEmpty else { return nil }
  return value
}

/// `Math.min(Math.max(parseInt(limit ?? 100) || 100, 1), 500)` (assets-symbols.js).
func clampSymbolLimit(_ value: String?) -> Int {
  let parsed = value.flatMap { Int($0) } ?? 100
  let base = parsed == 0 ? 100 : parsed
  return min(max(base, 1), 500)
}
