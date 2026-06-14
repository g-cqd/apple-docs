// The NIO bootstrap + the async serving loop + the response-writing envelope
// (RFC 0005 engine). HTTP/1.1 framing rides NIO, bridged to swift-http-types value
// types via `HTTP1ToHTTPServerCodec` so the whole engine speaks `HTTPRequest`/
// `HTTPResponse`/`HTTPFields` (RFC 0006 H1). Fully structured concurrency: each
// connection is a child task of the accept loop; the one blocking handler per
// `.storage` request is offloaded to the NIOThreadPool with a pooled connection.
// NO `@unchecked` (the sole contained one stays `ADStorage.StorageConnection`).

import HTTPTypes
import Logging
import NIOCore
import NIOHTTP1
import NIOHTTPTypes
import NIOHTTPTypesHTTP1
import NIOPosix
import ADStorage

/// The ad-server engine. Holds the immutable serving deps; `run()` binds the socket
/// and serves until cancelled. The app builds the `routes` table (DSL) + the response
/// `envelope` (the constant header set) and hands them in.
public struct HTTPServer: Sendable {
  let configuration: ServerConfiguration
  let pool: ConnectionPool
  let routes: any HTTPHandling
  /// The constant headers applied to every response (security set + Link + Vary).
  let envelope: HTTPFields
  let logger: Logger

  public init(
    configuration: ServerConfiguration, pool: ConnectionPool, routes: any HTTPHandling,
    envelope: HTTPFields, logger: Logger
  ) {
    self.configuration = configuration
    self.pool = pool
    self.routes = routes
    self.envelope = envelope
    self.logger = logger
  }

  public func run() async throws {
    let threadPool = NIOThreadPool(numberOfThreads: configuration.threadCount)
    threadPool.start()
    let group = MultiThreadedEventLoopGroup(numberOfThreads: configuration.loopCount)

    let serverChannel = try await ServerBootstrap(group: group)
      .serverChannelOption(ChannelOptions.backlog, value: 256)
      .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
      // TCP_NODELAY: without it Nagle + delayed ACKs add multi-ms latency to small
      // keep-alive responses (Bun.serve sets this; matching it is required).
      .childChannelOption(ChannelOptions.socketOption(.tcp_nodelay), value: 1)
      .bind(host: configuration.host, port: configuration.port) { childChannel in
        childChannel.eventLoop.makeCompletedFuture {
          try childChannel.pipeline.syncOperations.configureHTTPServerPipeline()
          // Bridge NIO's HTTP/1 parts ↔ swift-http-types parts (server, plaintext).
          try childChannel.pipeline.syncOperations.addHandler(HTTP1ToHTTPServerCodec(secure: false))
          return try NIOAsyncChannel<HTTPRequestPart, HTTPResponsePart>(
            wrappingChannelSynchronously: childChannel)
        }
      }
    logger.info(
      "ad-server listening",
      metadata: [
        "host": "\(configuration.host)", "port": "\(configuration.port)",
        "threads": "\(configuration.threadCount)", "loops": "\(configuration.loopCount)",
      ])

    try await withThrowingDiscardingTaskGroup { taskGroup in
      try await serverChannel.executeThenClose { inbound in
        for try await childChannel in inbound {
          taskGroup.addTask { await serveConnection(childChannel, threadPool: threadPool) }
        }
      }
    }
  }

  /// Serves successive requests on one connection until close / `Connection: close`.
  private func serveConnection(
    _ channel: NIOAsyncChannel<HTTPRequestPart, HTTPResponsePart>, threadPool: NIOThreadPool
  ) async {
    do {
      try await channel.executeThenClose { inbound, outbound in
        var requestHead: HTTPRequest?
        for try await part in inbound {
          switch part {
          case .head(let head):
            requestHead = head
          case .body:
            continue
          case .end:
            guard let head = requestHead else { continue }
            requestHead = nil
            let keepAlive = try await respond(to: head, outbound: outbound, threadPool: threadPool)
            if !keepAlive { return }
          }
        }
      }
    } catch {
      // Connection-level error (client reset, malformed framing) — drop it.
    }
  }

  /// Resolves + runs the route for one request, then writes the response. Returns
  /// whether to keep the connection alive.
  private func respond(
    to head: HTTPRequest, outbound: NIOAsyncChannelOutboundWriter<HTTPResponsePart>,
    threadPool: NIOThreadPool
  ) async throws -> Bool {
    let keepAlive = isKeepAlive(head)
    let target = head.path ?? "/"
    let request = ServerRequest(method: head.method, target: target, headers: head.headerFields)
    let requestID = resolveRequestID(head.headerFields)

    let content: ResponseContent
    var cache = CachePolicy.unset
    switch routes.match(method: head.method, path: request.path) {
    case .matched(let route):
      cache = route.cache
      let input = HandlerInput(
        request: request, connection: nil, logger: logger, requestID: requestID)
      if route.needsStorage {
        let pool = self.pool
        content = try await threadPool.runIfActive {
          guard let conn = pool.checkout() else { return .plain(.serviceUnavailable, "") }
          defer { pool.checkin(conn) }
          return route.run(
            HandlerInput(
              request: input.request, connection: conn, logger: input.logger,
              requestID: input.requestID))
        }
      } else {
        content = route.run(input)
      }
    case .methodNotAllowed:
      content = .plain(.methodNotAllowed, "method not allowed\n")
    case .notFound:
      content = .plain(.notFound, "not found\n")
    }

    try await write(
      content, cache: cache, requestHeaders: head.headerFields, requestID: requestID,
      keepAlive: keepAlive, outbound: outbound)
    return keepAlive
  }

  /// Applies the response envelope: ETag/304, content-type/length, cache-control, the
  /// constant header set, the minted/echoed request-id, and the connection header.
  private func write(
    _ content: ResponseContent, cache: CachePolicy, requestHeaders: HTTPFields, requestID: String,
    keepAlive: Bool, outbound: NIOAsyncChannelOutboundWriter<HTTPResponsePart>
  ) async throws {
    var (status, contentType, body) = materialize(content)
    var headers = HTTPFields()
    var emitEntity = true

    // ETag computed once from the original entity; on a match, blank the body → 304
    // but keep the ETag header (RFC 7232).
    if cache.etag {
      let etag = "\"\(sha256HexLower(body).prefix(16))\""
      headers[.eTag] = etag
      if let inm = requestHeaders[.ifNoneMatch], matchesIfNoneMatch(inm, etag) {
        status = .notModified
        body = []
        emitEntity = false
      }
    }
    if emitEntity {
      headers[.contentType] = contentType
      headers[.contentLength] = String(body.count)
    }
    if let cc = cache.cacheControl { headers[.cacheControl] = cc }
    headers.append(contentsOf: envelope)
    headers[requestIDName] = requestID
    headers[.connection] = keepAlive ? "keep-alive" : "close"

    try await outbound.write(.head(HTTPResponse(status: status, headerFields: headers)))
    if !body.isEmpty { try await outbound.write(.body(ByteBuffer(bytes: body))) }
    try await outbound.write(.end(nil))
  }

  private func materialize(_ content: ResponseContent)
    -> (status: HTTPResponse.Status, contentType: String, body: [UInt8])
  {
    switch content {
    case .raw(let b, let ct, let st): return (st, ct, b)
    case .notFound: return (.notFound, "text/plain; charset=utf-8", Array("Not Found".utf8))
    case .plain(let st, let msg): return (st, "text/plain; charset=utf-8", Array(msg.utf8))
    }
  }

  /// HTTP/1.1 default keep-alive unless `Connection: close` (HTTP/1.0 clients are out
  /// of scope; fetch + Caddy are 1.1). The request's version is consumed by the bridge.
  private func isKeepAlive(_ head: HTTPRequest) -> Bool {
    guard let connection = head.headerFields[.connection]?.lowercased() else { return true }
    return !connection.contains("close")
  }
}
