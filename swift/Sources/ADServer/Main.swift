// ad-server — the RFC 0001 P6 SwiftNIO host. A raw HTTP/1.1 server (NIOHTTP1,
// no Vapor) serving /healthz + /search over ADStorage IN-PROCESS (no FFI),
// alongside the Bun servers, reading the same WAL corpus. Uses the classic
// event-loop-confined serving model (ServerBootstrap + ChannelInboundHandler,
// the one offload via EventLoopFuture) rather than NIOAsyncChannel + a
// per-request Task: the async model did not scale under concurrency (see
// Handler.swift / the P6 records). Blocking reads are offloaded to a
// NIOThreadPool; the event loops only do IO/framing/dispatch.

import Dispatch
import NIOCore
import NIOHTTP1
import NIOPosix
import ADStorage

#if canImport(Glibc)
import Glibc
#else
import Darwin
#endif

@main
struct ADServerMain {
  static func main() throws {
    var dbPath: String?
    var port = 3032
    var threadCount = max(2, System.coreCount - 2)
    var loopCount = 2
    var benchIters: Int?
    var args = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = args.next() {
      switch arg {
      case "--db": dbPath = args.next()
      case "--port": if let v = args.next(), let p = Int(v) { port = p }
      case "--threads": if let v = args.next(), let t = Int(v) { threadCount = max(1, t) }
      case "--loops": if let v = args.next(), let l = Int(v) { loopCount = max(1, l) }
      case "--bench": if let v = args.next(), let n = Int(v) { benchIters = n }
      default: break
      }
    }
    guard let dbPath, !dbPath.isEmpty else {
      print("usage: ad-server --db <corpus.db> [--port 3032] [--threads N] [--bench ITERS]")
      exit(2)
    }

    // Diagnostic: time searchPagesJSON in-process — no NIO, no offload, no
    // HTTP — to isolate the read+JSON cost from the serving machinery.
    if let iters = benchIters {
      guard let conn = StorageConnection(path: dbPath) else {
        print("ad-server: cannot open \(dbPath)")
        exit(1)
      }
      let params = parseSearchParams("/search?q=view&framework=swiftui&limit=100")
      for _ in 0..<500 { _ = conn.searchPagesJSON(params) }
      let t0 = DispatchTime.now().uptimeNanoseconds
      for _ in 0..<iters { _ = conn.searchPagesJSON(params) }
      let ns = (DispatchTime.now().uptimeNanoseconds - t0) / UInt64(max(1, iters))
      print("searchPagesJSON in-process: \(ns) ns/call (\(Double(ns) / 1000.0) µs, \(iters) iters)")
      exit(0)
    }
    guard let pool = ConnectionPool(path: dbPath, count: threadCount) else {
      print("ad-server: cannot open \(dbPath) — libsqlite3/FTS5 unavailable?")
      exit(1)
    }

    let threadPool = NIOThreadPool(numberOfThreads: threadCount)
    threadPool.start()

    // Event-loop group: the cascade runs on the NIOThreadPool, so the loops
    // only do IO/framing/dispatch. --loops sweeps this to test whether the ELG
    // (not the per-request async machinery) bounds concurrency scaling.
    let group = MultiThreadedEventLoopGroup(numberOfThreads: loopCount)
    let bootstrap = ServerBootstrap(group: group)
      .serverChannelOption(ChannelOptions.backlog, value: 256)
      .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
      // TCP_NODELAY: without it, Nagle's algorithm + delayed ACKs add
      // multi-ms latency to small keep-alive responses (Bun.serve sets this
      // by default; matching it is required for a fair comparison).
      .childChannelOption(ChannelOptions.socketOption(.tcp_nodelay), value: 1)
      .childChannelInitializer { channel in
        channel.pipeline.configureHTTPServerPipeline().flatMap {
          channel.pipeline.addHandler(CascadeHandler(pool: pool, threadPool: threadPool))
        }
      }

    let serverChannel = try bootstrap.bind(host: "127.0.0.1", port: port).wait()
    print("ad-server listening on 127.0.0.1:\(port) (threads=\(threadCount), loops=\(loopCount), classic EL handler)")
    try serverChannel.closeFuture.wait()
  }
}
