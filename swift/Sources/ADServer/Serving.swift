// Async HTTP/1.1 connection handling over NIOAsyncChannel (RFC 0001 P6) — the
// ad-server serving path. Fully structured concurrency: each connection is a
// child task of the accept loop, the blocking cascade per request is offloaded
// to the NIOThreadPool with a pool-acquired connection, responses are written
// with async/await. NO `@unchecked Sendable`, no `NIOLoopBound`; the sole
// contained `@unchecked` stays `ADStorage.StorageConnection` (the `sqlite3*`
// wrapper).
//
// Routes: GET /healthz → static JSON; GET /search → the lexical cascade
// (Cascade.search), framed in-process. Keep-alive: the inbound loop serves
// successive requests on one connection until the client closes or a
// `Connection: close` response.

import NIOCore
import NIOHTTP1
import NIOPosix
import ADSearchCascade
import ADStorage

func serveConnection(
  _ channel: NIOAsyncChannel<HTTPServerRequestPart, HTTPServerResponsePart>,
  pool: ConnectionPool,
  threadPool: NIOThreadPool,
  config: SiteConfig
) async {
  do {
    try await channel.executeThenClose { inbound, outbound in
      var requestHead: HTTPRequestHead?
      for try await part in inbound {
        switch part {
        case .head(let head):
          requestHead = head
        case .body:
          continue
        case .end:
          guard let head = requestHead else { continue }
          requestHead = nil
          let keepAlive = try await respond(
            to: head, outbound: outbound, pool: pool, threadPool: threadPool, config: config)
          if !keepAlive { return }
        }
      }
    }
  } catch {
    // Connection-level error (client reset, malformed framing) — drop it.
  }
}

/// Writes the response for one request; returns whether to keep the
/// connection alive.
private func respond(
  to head: HTTPRequestHead,
  outbound: NIOAsyncChannelOutboundWriter<HTTPServerResponsePart>,
  pool: ConnectionPool,
  threadPool: NIOThreadPool,
  config: SiteConfig
) async throws -> Bool {
  let keepAlive = head.isKeepAlive
  let path = head.uri.prefix { $0 != "?" }

  guard head.method == .GET else {
    try await writeWeb(
      .plain(.methodNotAllowed, "method not allowed\n"), to: head, keepAlive: keepAlive,
      outbound: outbound)
    return keepAlive
  }

  let response: WebResponse
  switch path {
  case "/healthz":
    // Instance identity (not parity-gated). `no-store` so a cached 200 can't
    // mask a wedged origin.
    response = .json(Array(#"{"ok":true,"service":"ad-server"}"#.utf8), cacheControl: "no-store")
  case "/search":
    // ONE offload running the whole sequential cascade on one connection — the
    // CPU work (merge/rerank/JSON) stays off the event loop.
    let params = parseCascadeParams(head.uri)
    let body = try await threadPool.runIfActive {
      guard let conn = pool.checkout() else { return Cascade.emptyEnvelope }
      defer { pool.checkin(conn) }
      return Cascade.search(conn, params)
    }
    response = WebResponse(contentType: "application/json", body: body)
  case "/api/filters":
    let body = try await threadPool.runIfActive { () -> [UInt8] in
      guard let conn = pool.checkout() else {
        return Array(#"{"frameworks":[],"kinds":[],"wwdcYears":[]}"#.utf8)
      }
      defer { pool.checkin(conn) }
      return WebRoutes.filters(conn)
    }
    response = .json(body, cacheControl: WebConst.apiCorpusCacheControl)
  case "/readyz":
    let dbOk = try await threadPool.runIfActive { () -> Bool in
      guard let conn = pool.checkout() else { return false }
      defer { pool.checkin(conn) }
      return conn.probe()
    }
    response = WebRoutes.readyz(dbOk: dbOk)
  case "/api/fonts":
    let body = try await threadPool.runIfActive { () -> [UInt8] in
      guard let conn = pool.checkout() else { return Array(#"{"families":[]}"#.utf8) }
      defer { pool.checkin(conn) }
      return WebRoutes.fonts(conn)
    }
    response = .json(body, hashable: true)
  case "/api/fonts/faces.css":
    let baseUrl = config.baseUrl
    let body = try await threadPool.runIfActive { () -> [UInt8] in
      guard let conn = pool.checkout() else { return [] }
      defer { pool.checkin(conn) }
      return WebRoutes.fontFacesCss(conn, baseUrl: baseUrl)
    }
    response = .text(
      body, contentType: "text/css; charset=utf-8",
      cacheControl: WebConst.apiCorpusCacheControl, hashable: true)
  case "/api/symbols/index.json":
    let body = try await threadPool.runIfActive { () -> [UInt8] in
      guard let conn = pool.checkout() else { return Array(#"{"count":0,"symbols":[]}"#.utf8) }
      defer { pool.checkin(conn) }
      return WebRoutes.symbolsIndex(conn)
    }
    response = .json(body, hashable: true)
  case "/api/symbols/search":
    let params = parseQuery(head.uri)
    let rawQuery = params["q"] ?? ""
    let scope = nonEmptyScope(params["scope"])
    let limit = clampSymbolLimit(params["limit"])
    let body = try await threadPool.runIfActive { () -> [UInt8] in
      guard let conn = pool.checkout() else {
        return Array(#"{"results":[],"query":"","scope":null}"#.utf8)
      }
      defer { pool.checkin(conn) }
      return WebRoutes.symbolsSearch(conn, query: rawQuery, scope: scope, limit: limit)
    }
    response = .json(body, hashable: true)
  case "/data/search/search-manifest.json":
    let body = try await threadPool.runIfActive { () -> [UInt8] in
      guard let conn = pool.checkout() else {
        return Array(#"{"version":2,"titleCount":0,"aliasCount":0,"shardCount":0,"files":{},"generatedAt":""}"#.utf8)
      }
      defer { pool.checkin(conn) }
      return WebRoutes.searchManifest(conn)
    }
    response = .json(body, cacheControl: "no-cache", hashable: true)
  case "/data/search/title-index.json":
    let body = try await threadPool.runIfActive { () -> [UInt8] in
      guard let conn = pool.checkout() else { return Array("{}".utf8) }
      defer { pool.checkin(conn) }
      return WebRoutes.titleIndexBytes(conn)
    }
    response = .json(body)
  case "/data/search/aliases.json":
    let body = try await threadPool.runIfActive { () -> [UInt8] in
      guard let conn = pool.checkout() else { return Array("{}".utf8) }
      defer { pool.checkin(conn) }
      return WebRoutes.aliasMapBytes(conn)
    }
    response = .json(body)
  case "/robots.txt":
    response = .text(
      Discovery.robotsTxt(config), contentType: "text/plain; charset=utf-8",
      cacheControl: WebConst.discoveryCacheControl, hashable: true)
  case "/opensearch.xml":
    response = .text(
      Discovery.openSearchXml(config), contentType: "application/opensearchdescription+xml",
      cacheControl: WebConst.discoveryCacheControl, hashable: true)
  case "/.well-known/api-catalog":
    response = .text(
      Discovery.apiCatalog(config), contentType: "application/linkset+json",
      cacheControl: WebConst.discoveryCacheControl, hashable: true)
  case "/.well-known/mcp/server-card.json":
    response = .json(
      Discovery.mcpServerCard(config), cacheControl: WebConst.discoveryCacheControl, hashable: true)
  default:
    if let (scope, name) = matchSymbolMetadataPath(path) {
      let body = try await threadPool.runIfActive { () -> [UInt8]? in
        guard let conn = pool.checkout() else { return nil }
        defer { pool.checkin(conn) }
        return WebRoutes.symbolMetadata(conn, scope: scope, name: name)
      }
      response = body.map { .json($0, hashable: true) } ?? .plain(.notFound, "Not Found")
    } else if let base = matchHashedSearchArtifact(path) {
      let body = try await threadPool.runIfActive { () -> [UInt8] in
        guard let conn = pool.checkout() else { return Array("{}".utf8) }
        defer { pool.checkin(conn) }
        return base == "title-index" ? WebRoutes.titleIndexBytes(conn) : WebRoutes.aliasMapBytes(conn)
      }
      response = .json(body, cacheControl: "public, max-age=31536000, immutable", hashable: true)
    } else if let slug = matchFrameworkTreePath(path) {
      let baseUrl = config.baseUrl
      let body = try await threadPool.runIfActive { () -> [UInt8]? in
        guard let conn = pool.checkout() else { return nil }
        defer { pool.checkin(conn) }
        return WebRoutes.frameworkTree(conn, slug: slug, baseUrl: baseUrl)
      }
      response =
        body.map {
          .text(
            $0, contentType: "application/json; charset=utf-8",
            cacheControl: "public, max-age=31536000, immutable")
        } ?? .plain(.notFound, "Not Found")
    } else {
      response = .plain(.notFound, "not found\n")
    }
  }
  try await writeWeb(response, to: head, keepAlive: keepAlive, outbound: outbound)
  return keepAlive
}

/// `url.searchParams.get('scope') || undefined` — empty/absent → nil.
private func nonEmptyScope(_ s: String?) -> String? {
  guard let s, !s.isEmpty else { return nil }
  return s
}

/// `Math.min(Math.max(parseInt(limit ?? 100) || 100, 1), 500)` (assets-symbols.js).
private func clampSymbolLimit(_ s: String?) -> Int {
  let parsed = s.flatMap { Int($0) } ?? 100
  let base = parsed == 0 ? 100 : parsed
  return min(max(base, 1), 500)
}
