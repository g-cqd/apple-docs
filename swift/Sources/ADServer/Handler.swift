// Async HTTP/1.1 connection handling over NIOAsyncChannel (RFC 0001 P6 host
// spike). Fully structured concurrency — no ChannelInboundHandler, no
// NIOLoopBound, no @unchecked: each connection is an async task, the blocking
// searchPages read is offloaded to the NIOThreadPool with an actor-acquired
// connection, and responses are written back with async/await. Two routes:
//   GET /healthz → static JSON
//   GET /search  → searchPages, framed as JSON IN-PROCESS by ADStorage
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
    status = .ok
    contentType = "application/json"
    body = try await runSearch(uri: head.uri, pool: pool, threadPool: threadPool)
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

/// Runs the lexical cascade with the 3 tiers in PARALLEL — each tier is its
/// own thread-pool offload on its own connection (checked out inside, so a
/// thread holds ≤1 connection → pool sized = thread count never starves).
/// This matches Bun's per-tier reader-pool parallelism in-process. The
/// merge/rerank/projection (`assemble`) is pure + identical to the sequential
/// path, so byte-parity is unchanged.
private func runSearch(
  uri: String, pool: ConnectionPool, threadPool: NIOThreadPool
) async throws -> [UInt8] {
  let params = parseCascadeParams(uri)
  guard let prepared = Cascade.prepare(params) else { return Cascade.emptyEnvelope }
  let ftsParams = prepared.ftsParams
  let trigramParams = prepared.trigramParams
  async let titleExact = runTier(pool, threadPool) { $0.titleExactRows(ftsParams) }
  async let fts = runTier(pool, threadPool) { $0.ftsRows(ftsParams) }
  async let trigram = runTier(pool, threadPool) { $0.trigramRows(trigramParams) }
  let (te, ft, tr) = try await (titleExact, fts, trigram)
  return Cascade.assemble(prepared, titleExact: te, fts: ft, trigram: tr)
}

private func runTier(
  _ pool: ConnectionPool, _ threadPool: NIOThreadPool,
  _ body: @Sendable @escaping (StorageConnection) -> [SearchRow]?
) async throws -> [SearchRow] {
  try await threadPool.runIfActive {
    guard let conn = pool.checkout() else { return [] }
    defer { pool.checkin(conn) }
    return body(conn) ?? []
  }
}
