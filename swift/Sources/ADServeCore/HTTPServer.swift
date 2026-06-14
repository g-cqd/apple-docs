// The NIO bootstrap + the async serving loop + the response-writing envelope
// (RFC 0005/0007 engine). One NIO listener per `ListenerConfig`, all sharing one
// event-loop group, offload thread pool, connection pool, and response envelope (the
// central shared pool). HTTP/1.1 framing rides NIO, bridged to swift-http-types value
// types via `HTTP1ToHTTPServerCodec` so the whole engine speaks `HTTPRequest`/
// `HTTPResponse`/`HTTPFields` (RFC 0006 H1). Fully structured concurrency: each listener
// is a child task of `run()`; each connection a child task of its accept loop; the one
// blocking handler per `.storage` request is offloaded to the NIOThreadPool with a pooled
// connection. NO `@unchecked` (the sole contained one stays `ADStorage.StorageConnection`).
// (TLS 1.3 + HTTP/2 per-listener `Wire` variants land in F1b.)

public import HTTPTypes
public import Logging
import NIOCore
import NIOHTTP1
import NIOHTTPTypes
import NIOHTTPTypesHTTP1
import NIOPosix
public import ADStorage

/// The ad-server engine. Binds one NIO listener per `ListenerConfig`, all sharing the
/// event-loop group + offload pool + connection pool + envelope; serves until cancelled.
/// The app builds the listeners (DSL) + the response `envelope` and hands them in.
public struct HTTPServer: Sendable {
  let listeners: [ListenerConfig]
  let pool: ConnectionPool
  /// The constant headers applied to every response (security set + Link + Vary).
  let envelope: HTTPFields
  let logger: Logger
  let threadCount: Int
  let loopCount: Int

  public init(
    listeners: [ListenerConfig], pool: ConnectionPool, envelope: HTTPFields, logger: Logger,
    threadCount: Int, loopCount: Int = 2
  ) {
    self.listeners = listeners
    self.pool = pool
    self.envelope = envelope
    self.logger = logger
    self.threadCount = max(1, threadCount)
    self.loopCount = max(1, loopCount)
  }

  public func run() async throws {
    let threadPool = NIOThreadPool(numberOfThreads: threadCount)
    threadPool.start()
    let group = MultiThreadedEventLoopGroup(numberOfThreads: loopCount)

    try await withThrowingDiscardingTaskGroup { taskGroup in
      for listener in listeners {
        let serverChannel = try await bind(listener, group: group)
        let routes = listener.routes
        logger.info(
          "ad-server listening",
          metadata: [
            "host": "\(listener.host)", "port": "\(listener.port)",
            "threads": "\(threadCount)", "loops": "\(loopCount)",
          ])
        taskGroup.addTask {
          await serveListener(serverChannel, routes: routes, threadPool: threadPool)
        }
      }
    }
  }

  /// Binds one plaintext HTTP/1.1 listener. (The TLS + HTTP/2 `Wire` variants — ALPN
  /// negotiation via `configureAsyncHTTPServerPipeline` + NIOSSL — land in F1b.)
  private func bind(
    _ listener: ListenerConfig, group: MultiThreadedEventLoopGroup
  ) async throws -> NIOAsyncChannel<NIOAsyncChannel<HTTPRequestPart, HTTPResponsePart>, Never> {
    try await ServerBootstrap(group: group)
      .serverChannelOption(ChannelOptions.backlog, value: 256)
      .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
      // TCP_NODELAY: without it Nagle + delayed ACKs add multi-ms latency to small
      // keep-alive responses (Bun.serve sets this; matching it is required).
      .childChannelOption(ChannelOptions.socketOption(.tcp_nodelay), value: 1)
      .bind(host: listener.host, port: listener.port) { childChannel in
        childChannel.eventLoop.makeCompletedFuture {
          try childChannel.pipeline.syncOperations.configureHTTPServerPipeline()
          // Bridge NIO's HTTP/1 parts ↔ swift-http-types parts (server, plaintext).
          try childChannel.pipeline.syncOperations.addHandler(HTTP1ToHTTPServerCodec(secure: false))
          return try NIOAsyncChannel<HTTPRequestPart, HTTPResponsePart>(
            wrappingChannelSynchronously: childChannel)
        }
      }
  }

  /// The accept loop for one listener: each accepted connection becomes a child task.
  private func serveListener(
    _ serverChannel: NIOAsyncChannel<NIOAsyncChannel<HTTPRequestPart, HTTPResponsePart>, Never>,
    routes: any HTTPHandling, threadPool: NIOThreadPool
  ) async {
    do {
      try await withThrowingDiscardingTaskGroup { taskGroup in
        try await serverChannel.executeThenClose { inbound in
          for try await childChannel in inbound {
            taskGroup.addTask {
              await serveConnection(childChannel, routes: routes, threadPool: threadPool)
            }
          }
        }
      }
    } catch {
      // Listener-level error (group shutdown, accept failure) — stop this listener.
    }
  }

  /// Serves successive requests on one connection until close / `Connection: close`.
  private func serveConnection(
    _ channel: NIOAsyncChannel<HTTPRequestPart, HTTPResponsePart>, routes: any HTTPHandling,
    threadPool: NIOThreadPool
  ) async {
    do {
      try await channel.executeThenClose { inbound, outbound in
        var requestHead: HTTPRequest?
        var body: [UInt8] = []
        var overflow = false
        for try await part in inbound {
          switch part {
          case .head(let head):
            requestHead = head
            body = []
            overflow = false
          case .body(let buffer):
            if !overflow {
              body.append(contentsOf: buffer.readableBytesView)
              if body.count > Self.maxBodyBytes { overflow = true; body = [] }
            }
          case .end:
            guard let head = requestHead else { continue }
            requestHead = nil
            let keepAlive: Bool
            if overflow {
              try await writeBodyTooLarge(to: head, outbound: outbound)
              keepAlive = false
            } else {
              keepAlive = try await respond(
                to: head, body: body, routes: routes, outbound: outbound, threadPool: threadPool)
            }
            body = []
            if !keepAlive { return }
          }
        }
      }
    } catch {
      // Connection-level error (client reset, malformed framing) — drop it.
    }
  }

  /// 1 MiB request-body cap (matches the JS MCP `http-body.js`). Larger → 413 + close.
  private static let maxBodyBytes = 1_000_000

  private func writeBodyTooLarge(
    to head: HTTPRequest, outbound: NIOAsyncChannelOutboundWriter<HTTPResponsePart>
  ) async throws {
    try await write(
      .plain(HTTPResponse.Status(code: 413), "request too large\n"), cache: .unset,
      requestHeaders: head.headerFields, requestID: resolveRequestID(head.headerFields),
      keepAlive: false, outbound: outbound)
  }

  /// Resolves + runs the route for one request, then writes the response. Returns
  /// whether to keep the connection alive.
  private func respond(
    to head: HTTPRequest, body: [UInt8], routes: any HTTPHandling,
    outbound: NIOAsyncChannelOutboundWriter<HTTPResponsePart>, threadPool: NIOThreadPool
  ) async throws -> Bool {
    let keepAlive = isKeepAlive(head)
    let target = head.path ?? "/"
    let request = ServerRequest(
      method: head.method, target: target, headers: head.headerFields, body: body)
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
    var (status, contentType, body, extraHeaders) = materialize(content)
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
    // Route-supplied headers override the envelope (CORS / the MCP `/mcp` set).
    for field in extraHeaders { headers[field.name] = field.value }

    try await outbound.write(.head(HTTPResponse(status: status, headerFields: headers)))
    if !body.isEmpty { try await outbound.write(.body(ByteBuffer(bytes: body))) }
    try await outbound.write(.end(nil))
  }

  private func materialize(_ content: ResponseContent)
    -> (status: HTTPResponse.Status, contentType: String, body: [UInt8], headers: HTTPFields)
  {
    switch content {
    case .raw(let b, let ct, let st): return (st, ct, b, HTTPFields())
    case .notFound:
      return (.notFound, "text/plain; charset=utf-8", Array("Not Found".utf8), HTTPFields())
    case .plain(let st, let msg):
      return (st, "text/plain; charset=utf-8", Array(msg.utf8), HTTPFields())
    case .full(let b, let ct, let st, let h): return (st, ct, b, h)
    }
  }

  /// HTTP/1.1 default keep-alive unless `Connection: close` (HTTP/1.0 clients are out
  /// of scope; fetch + Caddy are 1.1). The request's version is consumed by the bridge.
  private func isKeepAlive(_ head: HTTPRequest) -> Bool {
    guard let connection = head.headerFields[.connection]?.lowercased() else { return true }
    return !connection.contains("close")
  }
}
