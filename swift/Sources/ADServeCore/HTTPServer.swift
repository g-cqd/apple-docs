// The NIO bootstrap + the async serving loop + the response-writing envelope
// (RFC 0005/0007 engine). One NIO listener per `ListenerConfig`, all sharing one
// event-loop group, offload thread pool, connection pool, and response envelope (the
// central shared pool). Each listener speaks its `Wire`: plaintext HTTP/1.1, or — under
// TLS — HTTP/1.1 and/or HTTP/2 chosen by ALPN. Both versions bridge to the SAME
// `HTTPRequest`/`HTTPResponse`/`HTTPFields` value types (RFC 0006 H1) via the NIOHTTPTypes
// codecs, so one `serveConnection` loop serves an h1 connection or an h2 stream identically.
// Fully structured concurrency: each listener is a child task of `run()`; each connection (or
// h2 stream) a child task of its accept loop; the one blocking handler per `.storage` request
// is offloaded to the NIOThreadPool with a pooled connection. NO `@unchecked` (the sole
// contained one stays `ADStorage.StorageConnection`).

public import HTTPTypes
public import Logging
import Dispatch
import NIOCore
import NIOHTTP1
import NIOHTTP2
import NIOHTTPTypes
import NIOHTTPTypesHTTP1
import NIOHTTPTypesHTTP2
import NIOPosix
import NIOSSL
import Synchronization
import ADStorage

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

// NIOTransportServices (Network.framework) is Apple-only; the engine falls back to NIOPosix
// elsewhere so the package still builds on Linux (the dylib + CI stay cross-platform).
#if canImport(Network)
import NIOTransportServices
#endif

/// One accepted connection (h1) or h2 stream: streams `HTTPRequestPart`/`HTTPResponsePart`.
private typealias EngineConnection = NIOAsyncChannel<HTTPRequestPart, HTTPResponsePart>
/// The ALPN outcome on a TLS connection: an h1 connection, or an h2 connection whose stream
/// channels arrive on the multiplexer.
private typealias EngineNegotiated = NIONegotiatedHTTPVersion<
  EngineConnection, (Void, NIOHTTP2Handler.AsyncStreamMultiplexer<EngineConnection>)
>

/// A shared count of requests actively being handled — so a drain waits for real in-flight
/// work (not idle keep-alive connections, which linger until force-closed). A lock-free
/// `Atomic` (the counter is hot: every request brackets it); boxed in a class so the
/// `~Copyable` atomic lives behind a shared reference the (copied) engine value carries.
private final class ActiveRequests: Sendable {
  private let value = Atomic<Int>(0)
  func enter() { value.wrappingAdd(1, ordering: .relaxed) }
  func leave() { value.wrappingSubtract(1, ordering: .relaxed) }
  var count: Int { value.load(ordering: .relaxed) }
}

/// A lightweight engine error with a message (startup/config failures).
private struct EngineError: Error { let message: String }

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
  /// Flipped true once all listeners are bound, false when draining (read by `/readyz`).
  let readiness: ServerReadiness?
  /// The bound transport — `.network` uses NIOTransportServices on Apple, else `.nio`.
  let transport: EngineTransport
  /// In-flight request count, so a drain waits for real work, not idle keep-alive connections.
  private let active = ActiveRequests()

  public init(
    listeners: [ListenerConfig], pool: ConnectionPool, envelope: HTTPFields, logger: Logger,
    threadCount: Int, loopCount: Int = 2, readiness: ServerReadiness? = nil,
    transport: EngineTransport = .nio
  ) {
    self.listeners = listeners
    self.pool = pool
    self.envelope = envelope
    self.logger = logger
    self.threadCount = max(1, threadCount)
    self.loopCount = max(1, loopCount)
    self.readiness = readiness
    self.transport = transport
  }

  public func run() async throws {
    let threadPool = NIOThreadPool(numberOfThreads: threadCount)
    threadPool.start()
    let group = makeEventLoopGroup()

    // Bind every listener up front, keeping the underlying server channels so a shutdown can
    // stop accepting (closing a listening channel ends its accept loop; existing connections
    // are untouched and drain on their own).
    var serverChannels: [any Channel] = []
    var serveTasks: [@Sendable () async -> Void] = []
    for listener in listeners {
      let routes = listener.routes
      logger.info(
        "ad-server listening",
        metadata: [
          "host": "\(listener.host)", "port": "\(listener.port)",
          "tls": "\(listener.wire.tls != nil)", "alpn": "\(listener.wire.alpn.map(\.rawValue))",
          "threads": "\(threadCount)", "loops": "\(loopCount)",
        ])
      if listener.wire.tls != nil {
        let serverChannel = try await bindSecure(listener, group: group)
        serverChannels.append(serverChannel.channel)
        serveTasks.append {
          await serveSecureListener(serverChannel, routes: routes, threadPool: threadPool)
        }
      } else {
        let serverChannel = try await bindPlain(listener, group: group)
        serverChannels.append(serverChannel.channel)
        serveTasks.append {
          await servePlainListener(serverChannel, routes: routes, threadPool: threadPool)
        }
      }
    }
    readiness?.set(true)

    // Graceful lifecycle: serve until SIGTERM/SIGINT, then stop accepting and let in-flight
    // requests drain (bounded by `drainSeconds`), then force-close. Finally shut the ELG +
    // offload pool down cleanly.
    let channelsToClose = serverChannels
    let tasks = serveTasks
    await withTaskGroup(of: ShutdownPhase.self) { taskGroup in
      taskGroup.addTask {
        await withDiscardingTaskGroup { serving in
          for serve in tasks { serving.addTask { await serve() } }
        }
        return .listenersFinished
      }
      taskGroup.addTask { await Self.awaitShutdownSignal(logger: logger); return .signal }

      if await taskGroup.next() == .signal {
        readiness?.set(false)
        logger.info("ad-server draining (stop accepting)")
        for channel in channelsToClose { channel.close(promise: nil) }
        // Wait for in-flight requests to finish (idle keep-alive connections are ignored),
        // bounded by the drain deadline; then force-close everything.
        let deadline = ContinuousClock.now.advanced(by: .seconds(Self.drainSeconds))
        while active.count > 0 && ContinuousClock.now < deadline {
          try? await Task.sleep(for: .milliseconds(50))
        }
        if active.count > 0 {
          logger.warning(
            "ad-server drain deadline exceeded; forcing close",
            metadata: ["inflight": "\(active.count)"])
        }
      }
      taskGroup.cancelAll()
    }

    try? await group.shutdownGracefully()
    try? await threadPool.shutdownGracefully()
    logger.info("ad-server stopped")
  }

  /// Max seconds to let in-flight requests finish after a shutdown signal before forcing close.
  private static let drainSeconds = 25

  private enum ShutdownPhase: Sendable, Equatable { case listenersFinished, signal }

  /// Suspends until SIGTERM or SIGINT.
  private static func awaitShutdownSignal(logger: Logger) async {
    for await sig in shutdownSignals() {
      logger.info("ad-server received signal \(sig); shutting down")
      return
    }
  }

  /// SIGTERM/SIGINT as an `AsyncStream` — Dispatch signal sources (the default handlers are
  /// ignored so the sources receive them) bridged to Swift concurrency.
  private static func shutdownSignals() -> AsyncStream<CInt> {
    AsyncStream { continuation in
      signal(SIGTERM, SIG_IGN)
      signal(SIGINT, SIG_IGN)
      let queue = DispatchQueue(label: "ad-server.signals")
      let sources = [SIGTERM, SIGINT].map { sig -> any DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
        source.setEventHandler { continuation.yield(sig) }
        source.resume()
        return source
      }
      continuation.onTermination = { _ in sources.forEach { $0.cancel() } }
    }
  }

  /// The event-loop group for the configured transport: NIOTransportServices
  /// (Network.framework) on Apple when `.network`, else NIOPosix.
  private func makeEventLoopGroup() -> any EventLoopGroup {
    #if canImport(Network)
    if transport == .network { return NIOTSEventLoopGroup(loopCount: loopCount) }
    #endif
    return MultiThreadedEventLoopGroup(numberOfThreads: loopCount)
  }

  private func baseBootstrap(_ group: any EventLoopGroup) -> ServerBootstrap {
    ServerBootstrap(group: group)
      .serverChannelOption(ChannelOptions.backlog, value: 256)
      .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
      // TCP_NODELAY: without it Nagle + delayed ACKs add multi-ms latency to small
      // keep-alive responses (Bun.serve sets this; matching it is required).
      .childChannelOption(ChannelOptions.socketOption(.tcp_nodelay), value: 1)
  }

  /// The plaintext HTTP/1.1 child pipeline — shared by both transports.
  private func plainInitializer() -> @Sendable (any Channel) -> EventLoopFuture<EngineConnection> {
    { childChannel in
      childChannel.eventLoop.makeCompletedFuture {
        try childChannel.pipeline.syncOperations.configureHTTPServerPipeline()
        // Bridge NIO's HTTP/1 parts ↔ swift-http-types parts (server, plaintext).
        try childChannel.pipeline.syncOperations.addHandler(HTTP1ToHTTPServerCodec(secure: false))
        return try EngineConnection(wrappingChannelSynchronously: childChannel)
      }
    }
  }

  /// Binds one plaintext HTTP/1.1 listener on the configured transport.
  private func bindPlain(
    _ listener: ListenerConfig, group: any EventLoopGroup
  ) async throws -> NIOAsyncChannel<EngineConnection, Never> {
    #if canImport(Network)
    if transport == .network {
      return try await NIOTSListenerBootstrap(group: group)
        .bind(
          host: listener.host, port: listener.port, childChannelInitializer: plainInitializer())
    }
    #endif
    return try await baseBootstrap(group)
      .bind(host: listener.host, port: listener.port, childChannelInitializer: plainInitializer())
  }

  /// Binds one TLS 1.3 listener that negotiates HTTP/1.1 or HTTP/2 by ALPN. Each child's
  /// output is the *negotiation future* — the initializer returns as soon as the ALPN handler
  /// is installed, so the channel activates and the handshake (which the negotiation depends
  /// on) can proceed; `serveSecureListener` awaits the result per connection. `autoRead` lets
  /// the handshake bytes flow before the inner per-connection channel takes over reads.
  private func bindSecure(
    _ listener: ListenerConfig, group: any EventLoopGroup
  ) async throws -> NIOAsyncChannel<EventLoopFuture<EngineNegotiated>, Never> {
    #if canImport(Network)
    if transport == .network {
      throw EngineError(message: "TLS over the .network transport is not yet implemented (F3b)")
    }
    #endif
    let sslContext = try makeTLSContext(listener.wire.tls!, alpn: listener.wire.alpn)
    return try await baseBootstrap(group)
      .childChannelOption(ChannelOptions.autoRead, value: true)
      .bind(host: listener.host, port: listener.port) { childChannel in
        childChannel.eventLoop.makeCompletedFuture {
          try childChannel.pipeline.syncOperations.addHandler(
            NIOSSLServerHandler(context: sslContext))
        }.flatMap {
          // `secure: true` ⇒ `:scheme https`. Returns EventLoopFuture<EventLoopFuture<…>>:
          // the OUTER (pipeline ready) is the child's init future; the INNER (negotiation) is
          // the child's output, awaited later.
          childChannel.configureAsyncHTTPServerPipeline(
            http1ConnectionInitializer: { channel in
              channel.eventLoop.makeCompletedFuture {
                try channel.pipeline.syncOperations.addHandler(HTTP1ToHTTPServerCodec(secure: true))
                return try EngineConnection(wrappingChannelSynchronously: channel)
              }
            },
            http2ConnectionInitializer: { channel in channel.eventLoop.makeSucceededVoidFuture() },
            http2StreamInitializer: { stream in
              stream.eventLoop.makeCompletedFuture {
                try stream.pipeline.syncOperations.addHandler(HTTP2FramePayloadToHTTPServerCodec())
                return try EngineConnection(wrappingChannelSynchronously: stream)
              }
            }
          )
        }
      }
  }

  /// Builds a TLS 1.3 server context from PEM material, advertising the listener's ALPN ids.
  private func makeTLSContext(_ tls: TLSSource, alpn: [ALPN]) throws -> NIOSSLContext {
    let chain = try NIOSSLCertificate.fromPEMFile(tls.certificatePath)
    let key = try NIOSSLPrivateKey(file: tls.privateKeyPath, format: .pem)
    var config = TLSConfiguration.makeServerConfiguration(
      certificateChain: chain.map { .certificate($0) }, privateKey: .privateKey(key))
    config.minimumTLSVersion = .tlsv13
    config.applicationProtocols = alpn.map(\.rawValue)
    return try NIOSSLContext(configuration: config)
  }

  /// The accept loop for a plaintext listener: each connection becomes a child task.
  private func servePlainListener(
    _ serverChannel: NIOAsyncChannel<EngineConnection, Never>, routes: any HTTPHandling,
    threadPool: NIOThreadPool
  ) async {
    do {
      try await withThrowingDiscardingTaskGroup { taskGroup in
        try await serverChannel.executeThenClose { inbound in
          for try await connection in inbound {
            taskGroup.addTask {
              await serveConnection(
                connection, routes: routes, threadPool: threadPool, isHTTP2: false)
            }
          }
        }
      }
    } catch {
      // Listener-level error (group shutdown, accept failure) — stop this listener.
    }
  }

  /// The accept loop for a TLS listener: per connection, await ALPN, then serve the h1
  /// connection or fan out the h2 stream channels.
  private func serveSecureListener(
    _ serverChannel: NIOAsyncChannel<EventLoopFuture<EngineNegotiated>, Never>,
    routes: any HTTPHandling, threadPool: NIOThreadPool
  ) async {
    do {
      try await withThrowingDiscardingTaskGroup { taskGroup in
        try await serverChannel.executeThenClose { inbound in
          for try await negotiation in inbound {
            taskGroup.addTask {
              guard let negotiated = try? await negotiation.get() else { return }
              switch negotiated {
              case .http1_1(let connection):
                await serveConnection(
                  connection, routes: routes, threadPool: threadPool, isHTTP2: false)
              case .http2(let (_, multiplexer)):
                await serveMultiplexer(multiplexer, routes: routes, threadPool: threadPool)
              }
            }
          }
        }
      }
    } catch {
      // Listener-level error — stop this listener.
    }
  }

  /// Serves an HTTP/2 connection: each inbound stream channel is one request, served as a
  /// child task (multiplexed concurrently over the one connection).
  private func serveMultiplexer(
    _ multiplexer: NIOHTTP2Handler.AsyncStreamMultiplexer<EngineConnection>,
    routes: any HTTPHandling, threadPool: NIOThreadPool
  ) async {
    do {
      try await withThrowingDiscardingTaskGroup { taskGroup in
        for try await stream in multiplexer.inbound {
          taskGroup.addTask {
            await serveConnection(stream, routes: routes, threadPool: threadPool, isHTTP2: true)
          }
        }
      }
    } catch {
      // Connection-level error (GOAWAY, reset) — drop it.
    }
  }

  /// Serves successive requests on one connection (h1) or one stream (h2) until close /
  /// `Connection: close` (h1) or stream end (h2).
  private func serveConnection(
    _ channel: EngineConnection, routes: any HTTPHandling, threadPool: NIOThreadPool,
    isHTTP2: Bool
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
            active.enter()
            defer { active.leave() }
            let keepAlive: Bool
            if overflow {
              try await writeBodyTooLarge(to: head, outbound: outbound, isHTTP2: isHTTP2)
              keepAlive = false
            } else {
              keepAlive = try await respond(
                to: head, body: body, routes: routes, outbound: outbound, threadPool: threadPool,
                isHTTP2: isHTTP2)
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
    to head: HTTPRequest, outbound: NIOAsyncChannelOutboundWriter<HTTPResponsePart>, isHTTP2: Bool
  ) async throws {
    try await write(
      .plain(HTTPResponse.Status(code: 413), "request too large\n"), cache: .unset,
      requestHeaders: head.headerFields, requestID: resolveRequestID(head.headerFields),
      keepAlive: false, isHTTP2: isHTTP2, outbound: outbound)
  }

  /// Resolves + runs the route for one request, then writes the response. Returns
  /// whether to keep the connection alive.
  private func respond(
    to head: HTTPRequest, body: [UInt8], routes: any HTTPHandling,
    outbound: NIOAsyncChannelOutboundWriter<HTTPResponsePart>, threadPool: NIOThreadPool,
    isHTTP2: Bool
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
          guard let lease = pool.lease() else { return .plain(.serviceUnavailable, "") }
          return route.run(
            HandlerInput(
              request: input.request, connection: lease.connection, logger: input.logger,
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
      keepAlive: keepAlive, isHTTP2: isHTTP2, outbound: outbound)
    return keepAlive
  }

  /// Applies the response envelope: ETag/304, content-type/length, cache-control, the
  /// constant header set, the minted/echoed request-id, and (h1 only) the connection header.
  private func write(
    _ content: ResponseContent, cache: CachePolicy, requestHeaders: HTTPFields, requestID: String,
    keepAlive: Bool, isHTTP2: Bool, outbound: NIOAsyncChannelOutboundWriter<HTTPResponsePart>
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
    // HTTP/2 forbids the connection-specific `Connection` header (an HTTP/1.1 concept).
    if !isHTTP2 { headers[.connection] = keepAlive ? "keep-alive" : "close" }
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
  /// of scope; fetch + Caddy are 1.1). For h2 this is unused (one request per stream).
  private func isKeepAlive(_ head: HTTPRequest) -> Bool {
    guard let connection = head.headerFields[.connection]?.lowercased() else { return true }
    return !connection.contains("close")
  }
}
