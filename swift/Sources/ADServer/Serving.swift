// Async HTTP/1.1 connection handling over NIOAsyncChannel (RFC 0001 P6) — the
// ad-server serving path. Fully structured concurrency: each connection is a
// child task of the accept loop, the blocking cascade per request is offloaded
// to the NIOThreadPool with a pool-acquired connection, responses are written
// with async/await. NO `@unchecked Sendable`, no `NIOLoopBound` — a measured
// head-to-head (RFC 0001 P6 records, third slice) found the EL-confined
// `@unchecked ChannelInboundHandler` alternative no faster (identical
// throughput at c=1..16), so the safe model is kept. The sole contained
// `@unchecked` stays `ADStorage.StorageConnection` (the `sqlite3*` wrapper).
// Two routes:
//   GET /healthz → static JSON
//   GET /search  → the lexical cascade (Cascade.search), framed in-process
// Keep-alive: the inbound loop serves successive requests on one connection
// until the client closes or a `Connection: close` response.

import NIOCore
import NIOHTTP1
import NIOPosix
import ADSearchCascade
import ADStorage

func serveConnection(
  _ channel: NIOAsyncChannel<HTTPServerRequestPart, HTTPServerResponsePart>,
  pool: ConnectionPool,
  threadPool: NIOThreadPool
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
            to: head, outbound: outbound, pool: pool, threadPool: threadPool)
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
  threadPool: NIOThreadPool
) async throws -> Bool {
  let keepAlive = head.isKeepAlive
  let path = head.uri.prefix { $0 != "?" }

  let status: HTTPResponseStatus
  let contentType: String
  let body: [UInt8]

  if head.method != .GET {
    status = .methodNotAllowed
    contentType = "text/plain"
    body = Array("method not allowed\n".utf8)
  } else if path == "/healthz" {
    status = .ok
    contentType = "application/json"
    body = Array(#"{"ok":true,"service":"ad-server"}"#.utf8)
  } else if path == "/search" {
    let params = parseCascadeParams(head.uri)
    status = .ok
    contentType = "application/json"
    // ONE offload running the whole sequential cascade on one connection — the
    // CPU work (merge/rerank/JSON) stays off the event loop.
    body = try await threadPool.runIfActive {
      guard let conn = pool.checkout() else { return Cascade.emptyEnvelope }
      defer { pool.checkin(conn) }
      return Cascade.search(conn, params)
    }
  } else if path == "/search-rawscan" || path == "/search-decode" {
    // DIAGNOSTIC (RFC 0001 P6 probe — to be removed): isolate the stages of the
    // cascade to localize the concurrency contention. -rawscan = the 3 tier
    // SQL, COUNT only (SQLite scan, no String decode). -decode = + the
    // SearchRow String decode (no merge/rerank/JSON). vs /search = full.
    let params = parseCascadeParams(head.uri)
    let rawscan = path == "/search-rawscan"
    status = .ok
    contentType = "application/json"
    body = try await threadPool.runIfActive {
      guard let p = Cascade.prepare(params), let conn = pool.checkout() else {
        return Array(#"{"n":0}"#.utf8)
      }
      defer { pool.checkin(conn) }
      let n: Int
      if rawscan {
        n = conn.rawScanCount(fts: p.ftsParams, trigram: p.trigramParams)
      } else {
        n = (conn.titleExactRows(p.ftsParams)?.count ?? 0)
          + (conn.ftsRows(p.ftsParams)?.count ?? 0)
          + (conn.trigramRows(p.trigramParams)?.count ?? 0)
      }
      return Array("{\"n\":\(n)}".utf8)
    }
  } else {
    status = .notFound
    contentType = "text/plain"
    body = Array("not found\n".utf8)
  }

  var headers = HTTPHeaders()
  headers.add(name: "content-type", value: contentType)
  headers.add(name: "content-length", value: String(body.count))
  headers.add(name: "connection", value: keepAlive ? "keep-alive" : "close")
  try await outbound.write(.head(HTTPResponseHead(version: head.version, status: status, headers: headers)))
  try await outbound.write(.body(.byteBuffer(ByteBuffer(bytes: body))))
  try await outbound.write(.end(nil))
  return keepAlive
}
