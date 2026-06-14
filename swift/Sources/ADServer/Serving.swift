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
    response = .plain(.notFound, "not found\n")
  }
  try await writeWeb(response, to: head, keepAlive: keepAlive, outbound: outbound)
  return keepAlive
}
