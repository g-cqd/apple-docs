// Classic event-loop-confined HTTP/1.1 handler (RFC 0001 P6 — the serving-model
// experiment). The async NIOAsyncChannel model (a per-request Task + offloads on
// the Swift cooperative executor, oversubscribed against the event loops) did
// NOT scale under concurrency — throughput DEGRADED while Bun scaled, even
// though the cascade WORK is comparable at c=1. This reverts to the model that
// scaled /healthz to ~67k rps: a `ChannelInboundHandler` running ON the event
// loop, with the one blocking cascade offloaded via a single
// `NIOThreadPool.runIfActive(eventLoop:)` (an `EventLoopFuture`, no Task, no
// cooperative executor), the response written back on the loop. The handler is
// `@unchecked Sendable` — discouraged in general, but here it is the contained,
// EL-confinement-safe kind: NIO guarantees `channelRead` and the future
// callbacks run on this channel's single event loop, so the `requestHead`
// mutable state is never touched concurrently. `NIOLoopBound` carries the
// (non-Sendable) context across the offload's completion, which fires on the
// same loop.
//
// One offload per request runs the WHOLE cascade sequentially on ONE connection
// (tier parallelism was measured irrelevant — the cascade is ~2 ms at c=1); the
// CPU work (merge/rerank/JSON) stays off the event loop.

import NIOCore
import NIOHTTP1
import NIOPosix
import ADSearchCascade
import ADStorage

final class CascadeHandler: ChannelInboundHandler, @unchecked Sendable {
  typealias InboundIn = HTTPServerRequestPart
  typealias OutboundOut = HTTPServerResponsePart

  private let pool: ConnectionPool
  private let threadPool: NIOThreadPool
  private var requestHead: HTTPRequestHead?

  init(pool: ConnectionPool, threadPool: NIOThreadPool) {
    self.pool = pool
    self.threadPool = threadPool
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    switch unwrapInboundIn(data) {
    case .head(let head):
      requestHead = head
    case .body:
      break
    case .end:
      guard let head = requestHead else { return }
      requestHead = nil
      route(context: context, head: head)
    }
  }

  private func route(context: ChannelHandlerContext, head: HTTPRequestHead) {
    let keepAlive = head.isKeepAlive
    let version = head.version
    let path = head.uri.prefix { $0 != "?" }

    guard head.method == .GET else {
      respond(
        context: context, status: .methodNotAllowed, contentType: "text/plain",
        body: Array("method not allowed\n".utf8), keepAlive: keepAlive, version: version)
      return
    }

    if path == "/healthz" {
      respond(
        context: context, status: .ok, contentType: "application/json",
        body: Array(#"{"ok":true,"service":"ad-server"}"#.utf8), keepAlive: keepAlive,
        version: version)
      return
    }

    if path == "/search" {
      let params = parseCascadeParams(head.uri)
      let pool = self.pool
      let eventLoop = context.eventLoop
      let boundContext = NIOLoopBound(context, eventLoop: eventLoop)
      let boundSelf = NIOLoopBound(self, eventLoop: eventLoop)
      // ONE offload: the whole sequential cascade on one connection, off the
      // event loop. Checkout happens INSIDE so a thread holds ≤1 connection
      // (pool sized = thread count → never starves).
      threadPool.runIfActive(eventLoop: eventLoop) { () -> [UInt8] in
        guard let conn = pool.checkout() else { return Cascade.emptyEnvelope }
        defer { pool.checkin(conn) }
        return Cascade.search(conn, params)
      }.whenComplete { result in
        let body = (try? result.get()) ?? Cascade.emptyEnvelope
        boundSelf.value.respond(
          context: boundContext.value, status: .ok, contentType: "application/json",
          body: body, keepAlive: keepAlive, version: version)
      }
      return
    }

    respond(
      context: context, status: .notFound, contentType: "text/plain",
      body: Array("not found\n".utf8), keepAlive: keepAlive, version: version)
  }

  private func respond(
    context: ChannelHandlerContext, status: HTTPResponseStatus, contentType: String,
    body: [UInt8], keepAlive: Bool, version: HTTPVersion
  ) {
    var headers = HTTPHeaders()
    headers.add(name: "content-type", value: contentType)
    headers.add(name: "content-length", value: String(body.count))
    headers.add(name: "connection", value: keepAlive ? "keep-alive" : "close")
    context.write(
      wrapOutboundOut(.head(HTTPResponseHead(version: version, status: status, headers: headers))),
      promise: nil)
    context.write(wrapOutboundOut(.body(.byteBuffer(ByteBuffer(bytes: body)))), promise: nil)
    if keepAlive {
      context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
    } else {
      let channel = context.channel
      context.writeAndFlush(wrapOutboundOut(.end(nil))).whenComplete { _ in
        channel.close(promise: nil)
      }
    }
  }
}
