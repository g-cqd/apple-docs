// The ad-server endpoint declarations (RFC 0005), in the hierarchical ADServeDSL:
// `Server { App(pool:) { Group(prefix) { GET(subpath, pool:) { ctx in … }.cache(…) } } }`.
// The pool is a typed parameter that picks the handler context (`.shared` → `ctx.db`,
// `.none` → no DB); handlers are trailing closures; output is a typed `MediaType`. The
// engine applies the cross-cutting envelope (built below) to every response; routes only
// opt into cache/ETag. Business logic stays in WebRoutes/Discovery/Cascade — declarations
// just wire path → logic.

import ADJSON
import ADSearchCascade
import ADServeCore
import ADServeDSL
import ADStorage
import HTTPTypes

/// The server's applications — one per `App`, each binding one NIO listener. Closes over the
/// site config (discovery + tree hrefs) + the shared MCP dispatcher (the HTTP `/mcp` transport).
func endpoints(config: SiteConfig, mcpDispatcher: MCPDispatcher) -> [Application] {
  // The whole route surface in the hierarchical, type-safe DSL (RFC 0005/0007): `Server { App(port:,
  // pool:) { Group(prefix) { GET(subpath) { ctx in … } } } }`. The pool is a typed PARAMETER that
  // picks the handler's context (`.none` ⇒ no `ctx.db`, compile-enforced); handlers are trailing
  // closures; output is a typed `MediaType`. Each `App` lowers to one engine listener via
  // `listeners(_:defaultPort:)`; the shared connection pool spans them all.
  Server {
      App(pool: .shared) {                                    // an application on a port; the central shared pool
        // Liveness — static, no storage, never cached.
        GET("healthz", pool: .none) { _ in
          .json(Array(#"{"ok":true,"service":"ad-server"}"#.utf8), as: .json)
        }.cache(.noStore)

        // Lexical search cascade. `application/json` (no charset) + no cache, as Bun.
        GET("search") { ctx in
          .json(Cascade.search(ctx.db, parseCascadeParams(ctx.target)), as: .jsonRaw)
        }

        // Readiness — the DB probe; status carries ok/503, the route carries `no-store`.
        GET("readyz") { ctx in WebRoutes.readyz(dbOk: ctx.db.probe()) }.cache(.noStore)

        Group("api") {
          GET("filters") { ctx in .json(WebRoutes.filters(ctx.db), as: .json) }.cache(.apiCorpus)
          GET("fonts") { ctx in .json(WebRoutes.fonts(ctx.db), as: .json) }.etag
          GET("fonts/faces.css") { ctx in
            .text(WebRoutes.fontFacesCss(ctx.db, baseUrl: config.baseUrl), as: .css)
          }.cache(.apiCorpus, etag: true)
          Group("symbols") {
            GET("index.json") { ctx in .json(WebRoutes.symbolsIndex(ctx.db), as: .json) }.etag
            GET("search") { ctx in
              let query = parseQuery(ctx.target)
              return .json(
                WebRoutes.symbolsSearch(
                  ctx.db, query: query["q"] ?? "", scope: nonEmptyScope(query["scope"]),
                  limit: clampSymbolLimit(query["limit"])), as: .json)
            }.etag
          }
        }

        Group("data/search") {
          GET("search-manifest.json") { ctx in
            .json(WebRoutes.searchManifest(ctx.db), as: .json)
          }.cache(.noCache, etag: true)
          GET("title-index.json") { ctx in .json(WebRoutes.titleIndexBytes(ctx.db), as: .json) }
          GET("aliases.json") { ctx in .json(WebRoutes.aliasMapBytes(ctx.db), as: .json) }
        }

        // ---- discovery (pure siteConfig, no storage) ----
        GET("robots.txt", pool: .none) { _ in
          .text(Discovery.robotsTxt(config), as: .text)
        }.cache(.discovery, etag: true)
        GET("opensearch.xml", pool: .none) { _ in
          .text(Discovery.openSearchXml(config), as: .openSearch)
        }.cache(.discovery, etag: true)
        Group(".well-known") {
          GET("api-catalog", pool: .none) { _ in
            .text(Discovery.apiCatalog(config), as: .linkset)
          }.cache(.discovery, etag: true)
          GET("mcp/server-card.json", pool: .none) { _ in
            .json(Discovery.mcpServerCard(config), as: .json)
          }.cache(.discovery, etag: true)
        }

        // ---- pattern routes (typed matchers; irregular grammar) ----
        GET(match: matchSymbolMetadataPath) { ctx, symbol in
          WebRoutes.symbolMetadata(ctx.db, scope: symbol.scope, name: symbol.name)
            .map { ResponseContent.json($0, as: .json) } ?? .notFound
        }.etag
        GET(match: matchHashedSearchArtifact) { ctx, base in
          .json(
            base == "title-index" ? WebRoutes.titleIndexBytes(ctx.db) : WebRoutes.aliasMapBytes(ctx.db),
            as: .json)
        }.cache(.immutable, etag: true)
        GET(match: matchFrameworkTreePath) { ctx, slug in
          WebRoutes.frameworkTree(ctx.db, slug: slug, baseUrl: config.baseUrl)
            .map { ResponseContent.text($0, as: .jsonSpaced) } ?? .notFound
        }.cache(.immutable)

        // MCP over HTTP (Phase D1) — the second transport, on the same engine.
        POST("mcp") { ctx in handleMCPPost(ctx, dispatcher: mcpDispatcher) }.cache(.noStore)
        OPTIONS("mcp") { ctx in handleMCPOptions(ctx) }
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
