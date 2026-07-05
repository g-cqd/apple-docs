// The ad-server endpoint declarations, in the hierarchical ADServeDSL:
// `Server { App(pool:) { Scope(prefix) { GET(subpath, pool:) { ctx in … }.cache(…) } } }`.
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
// HTTPCore: ADServe's engine re-based onto the HTTP package — the response
// statuses, HTTPFields, and HTTPFieldName are defined there
// (MemberImportVisibility requires importing the DEFINING module).
import HTTPCore

/// The server's applications — the plaintext loopback (behind Caddy) + an optional in-process
/// TLS listener (the operator's "Both" model), both sharing `siteRoutes`. Closes over the site
/// config + the shared MCP dispatcher (the HTTP `/mcp` transport). `dataDir` is the corpus data
/// directory (`CorpusOptions.dataDir` in Main.swift) the font routes containment-check against
/// and cache into (`resources/fonts/extracted`, `resources/fonts/zips`).
func endpoints(
    config: SiteConfig, mcpDispatcher: MCPDispatcher, tls: TLSSource?, tlsPort: Int,
    readiness: ServerReadiness, dataDir: String
) -> [Application] {
    Server {
        // Loopback (plaintext HTTP/1.1, behind Caddy) on the process default port.
        App(pool: .shared) {
            siteRoutes(
                config: config, mcpDispatcher: mcpDispatcher, readiness: readiness, dataDir: dataDir)
        }
        // Optional in-process TLS listener — TLS 1.3 with ALPN (HTTP/2 + HTTP/1.1) on `tlsPort`.
        if let tls {
            App(port: tlsPort, protocol: .https(tls), pool: .shared) {
                siteRoutes(
                    config: config, mcpDispatcher: mcpDispatcher, readiness: readiness, dataDir: dataDir)
            }
        }
    }
}

/// `GET /search` handler: parse cascade params, bound the query length, run the lexical cascade.
func searchHandler(_ ctx: StorageContext) -> ResponseContent {
    guard let params = parseCascadeParams(ctx.target) else {
        return .plain(.badRequest, "malformed query\n")
    }
    guard params.query.utf8.count <= maxSearchQueryBytes else {
        return .plain(.badRequest, "query too long\n")
    }
    return .json(Cascade.search(ctx.db, params), as: .jsonRaw)
}

/// `GET /api/symbols/search` handler: parse the query map, bound the query length, run symbol search.
func symbolsSearchHandler(_ ctx: StorageContext) -> ResponseContent {
    guard let query = parseQuery(ctx.target) else {
        return .plain(.badRequest, "malformed query\n")
    }
    guard (query["q"] ?? "").utf8.count <= maxSearchQueryBytes else {
        return .plain(.badRequest, "query too long\n")
    }
    return .json(
        WebRoutes.symbolsSearch(
            ctx.db, query: query["q"] ?? "", scope: nonEmptyScope(query["scope"]),
            limit: clampSymbolLimit(query["limit"])), as: .json)
}

/// `GET /api/fonts/text.svg` handler: parse `?text=&fontId=&size=`, delegate to WebRoutes.
func fontTextSvgHandler(_ ctx: StorageContext, dataDir: String) -> ResponseContent {
    guard let query = parseQuery(ctx.target) else {
        return .plain(.badRequest, "malformed query\n")
    }
    return WebRoutes.fontTextSvg(
        ctx.db, fontId: query["fontId"], text: query["text"], size: query["size"].flatMap(Int.init),
        dataDir: dataDir)
}

/// `GET /api/fonts/file/{id}` handler — the path-template capture is already percent-decoded and
/// traversal-checked by `PathTemplate`.
func fontFileHandler(_ ctx: StorageContext, _ params: PathParameters, dataDir: String) -> ResponseContent {
    guard let id = params.id else { return .notFound }
    return WebRoutes.fontFile(ctx.db, id: id, dataDir: dataDir)
}

/// `GET /api/fonts/family/<id>.zip` handler: parse `?subset=`.
func fontFamilyZipHandler(_ ctx: StorageContext, _ familyId: String, dataDir: String) -> ResponseContent {
    let subset = FontZipSubset(query: parseQuery(ctx.target)?["subset"])
    return WebRoutes.fontFamilyZip(ctx.db, familyId: familyId, subset: subset, dataDir: dataDir)
}

/// `GET /api/symbols/<scope>/<name>.(svg|png)` handler: parse the render param bag (fg/color/bg/
/// size/weight/scale), 400 on an invalid value (`WebRoutes.symbolRenderFromQuery`'s job).
func symbolRenderHandler(
    _ ctx: StorageContext, _ match: (scope: String, name: String, format: String)
) -> ResponseContent {
    guard let query = parseQuery(ctx.target) else {
        return .plain(.badRequest, "malformed query\n")
    }
    return WebRoutes.symbolRenderFromQuery(
        ctx.db, scope: match.scope, name: match.name, format: match.format, query: query)
}

/// The whole route surface, shared by every `App`/listener. The pool picks the handler context
/// (`.shared` → `ctx.db`; `.none` → no DB); handlers are trailing closures; output is a typed
/// `MediaType`. The engine applies the cross-cutting envelope to every response.
@RouteGroupBuilder
func siteRoutes(
    config: SiteConfig, mcpDispatcher: MCPDispatcher, readiness: ServerReadiness, dataDir: String
) -> [RouteNode] {
    // Liveness — static, no storage, never cached.
    GET("healthz", pool: .none) { _ in
        .json(Array(#"{"ok":true,"service":"ad-server"}"#.utf8), as: .json)
    }
    .cache(.noStore)

    // Lexical search cascade. `application/json` (no charset) + no cache, as Bun.
    GET("search") { searchHandler($0) }

    // Readiness — 503 while draining (orchestrators stop new traffic), else the DB probe.
    GET("readyz") { ctx in
        readiness.isReady
            ? WebRoutes.readyz(dbOk: ctx.db.probe()) : .plain(.serviceUnavailable, "draining\n")
    }
    .cache(.noStore)

    Scope("api") {
        GET("filters") { ctx in .json(WebRoutes.filters(ctx.db), as: .json) }.cache(.apiCorpus)
        GET("fonts") { ctx in .json(WebRoutes.fonts(ctx.db), as: .json) }.etag
        GET("fonts/faces.css") { ctx in
            .text(WebRoutes.fontFacesCss(ctx.db, baseUrl: config.baseUrl), as: .css)
        }
        .cache(.apiCorpus, etag: true)
        // Live-rendered text sample (a Swift/ADRender font preview, byte-derived → content-hash
        // ETag via the generic `.etag` mechanism, matching JS's own hashable-response ETag).
        GET("fonts/text.svg") { fontTextSvgHandler($0, dataDir: dataDir) }
            .cache(.fontRender, etag: true)
        // The extracted font FILE itself (not a render) — a stable on-disk asset, so it gets the
        // engine's own strong size+mtime ETag via `.file()` instead of a content-hash.
        GET("fonts/file/{id}") { ctx, params in fontFileHandler(ctx, params, dataDir: dataDir) }
            .cache(.fontFile)
        Scope("symbols") {
            GET("index.json") { ctx in .json(WebRoutes.symbolsIndex(ctx.db), as: .json) }.etag
            GET("search") { symbolsSearchHandler($0) }
                .etag
        }
    }

    Scope("data/search") {
        GET("search-manifest.json") { ctx in
            .json(WebRoutes.searchManifest(ctx.db), as: .json)
        }
        .cache(.noCache, etag: true)
        GET("title-index.json") { ctx in .json(WebRoutes.titleIndexBytes(ctx.db), as: .json) }
        GET("aliases.json") { ctx in .json(WebRoutes.aliasMapBytes(ctx.db), as: .json) }
    }

    // ---- discovery (pure siteConfig, no storage) ----
    GET("robots.txt", pool: .none) { _ in
        .text(Discovery.robotsTxt(config), as: .text)
    }
    .cache(.discovery, etag: true)
    GET("opensearch.xml", pool: .none) { _ in
        .text(Discovery.openSearchXml(config), as: .openSearch)
    }
    .cache(.discovery, etag: true)
    Scope(".well-known") {
        GET("api-catalog", pool: .none) { _ in
            .text(Discovery.apiCatalog(config), as: .linkset)
        }
        .cache(.discovery, etag: true)
        GET("mcp/server-card.json", pool: .none) { _ in
            .json(Discovery.mcpServerCard(config), as: .json)
        }
        .cache(.discovery, etag: true)
    }

    // ---- pattern routes (typed matchers; irregular grammar) ----
    GET(match: matchSymbolMetadataPath) { ctx, symbol in
        WebRoutes.symbolMetadata(ctx.db, scope: symbol.scope, name: symbol.name)
            .map { ResponseContent.json($0, as: .json) } ?? .notFound
    }
    .etag
    GET(match: matchHashedSearchArtifact) { ctx, base in
        .json(
            base == "title-index" ? WebRoutes.titleIndexBytes(ctx.db) : WebRoutes.aliasMapBytes(ctx.db),
            as: .json)
    }
    .cache(.immutable, etag: true)
    GET(match: matchFrameworkTreePath) { ctx, slug in
        WebRoutes.frameworkTree(ctx.db, slug: slug, baseUrl: config.baseUrl)
            .map { ResponseContent.text($0, as: .jsonSpaced) } ?? .notFound
    }
    .cache(.immutable)
    // A stable ZIP built on disk once per (family, subset, input-fingerprint) — the engine's own
    // `.file()` ETag applies, same rationale as `fonts/file/{id}` above.
    GET(match: matchFontFamilyZipPath) { ctx, familyId in
        fontFamilyZipHandler(ctx, familyId, dataDir: dataDir)
    }
    .cache(.fontFile)
    // Live-rendered SF Symbol (svg markup or png bytes) — content-hash ETag via `.etag`, same
    // rationale as `fonts/text.svg` above.
    GET(match: matchSymbolRenderPath) { ctx, match in symbolRenderHandler(ctx, match) }
        .cache(.fontRender, etag: true)

    // MCP over HTTP — the second transport, on the same engine.
    POST("mcp") { ctx in handleMCPPost(ctx, dispatcher: mcpDispatcher) }.cache(.noStore)
    OPTIONS("mcp") { ctx in handleMCPOptions(ctx) }
}

// MARK: - The response envelope (constant headers on every response)

/// The cross-cutting header set: the security headers, the RFC 8288 `Link` set, and
/// `Vary: Accept`. Built once as `HTTPFields` and applied by the engine.
func buildEnvelope() -> HTTPFields {
    // CSP. DEVIATION: the 404-page inline script hash is omitted — ad-server serves no
    // inline scripts and CSP is inert on JSON/text API responses.
    let csp =
        "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; "
        + "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; "
        + "base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    let discoveryLinks =
        #"</sitemap.xml>; rel="sitemap", </.well-known/api-catalog>; rel="api-catalog", </docs/>; rel="service-doc", </opensearch.xml>; rel="search""#

    var fields = HTTPFields()
    fields.append("nosniff", for: fieldName("x-content-type-options"))
    fields.append("DENY", for: fieldName("x-frame-options"))
    fields.append("strict-origin-when-cross-origin", for: fieldName("referrer-policy"))
    fields.append(
        "camera=(), geolocation=(), microphone=(), payment=(), usb=()", for: fieldName("permissions-policy"))
    fields.append("same-origin", for: fieldName("cross-origin-opener-policy"))
    fields.append("same-origin", for: fieldName("cross-origin-resource-policy"))
    fields.append(csp, for: fieldName("content-security-policy"))
    fields.append(discoveryLinks, for: fieldName("link"))
    fields.append("Accept", for: fieldName("vary"))
    return fields
}

private func fieldName(_ name: String) -> HTTPFieldName { HTTPFieldName(name)! }

// MARK: - App cache presets + route param helpers

extension CachePolicy {
    /// Corpus-derived JSON.
    static let apiCorpus = CachePolicy(cacheControl: "public, max-age=300, stale-while-revalidate=3600")
    /// Discovery endpoints (a pure function of siteConfig).
    static let discovery = CachePolicy(cacheControl: "public, max-age=3600")
    /// Live-rendered font/symbol bytes (JS: `Cache-Control: public, max-age=86400` +
    /// content-hash ETag via `fileResponseRevalidated`/`finalizeResponse`'s hashable path).
    static let fontRender = CachePolicy(cacheControl: "public, max-age=86400")
    /// An on-disk font asset (the extracted file itself, or the built family ZIP) — `.file()`
    /// supplies its own strong size+mtime ETag regardless of this policy's `etag` flag, so only
    /// `cacheControl` matters here (JS: `public, max-age=86400, must-revalidate` on both routes).
    static let fontFile = CachePolicy(cacheControl: "public, max-age=86400, must-revalidate")
}

/// `url.searchParams.get('scope') || undefined` — empty/absent → nil.
func nonEmptyScope(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}

/// `Math.min(Math.max(parseInt(limit ?? 100) || 100, 1), 500)`.
func clampSymbolLimit(_ value: String?) -> Int {
    let parsed = value.flatMap { Int($0) } ?? 100
    let base = parsed == 0 ? 100 : parsed
    return min(max(base, 1), 500)
}
