// ad-server — the RFC 0001 P6 SwiftNIO host spike. A raw HTTP/1.1 server
// (NIOHTTP1, no Vapor) serving /healthz + /search over ADStorage IN-PROCESS
// (no FFI), alongside the Bun servers, reading the same WAL corpus. Built on
// NIO's async/await API (NIOAsyncChannel) under complete strict concurrency:
// each accepted connection is an independent structured Task.

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
  static func main() async throws {
    var dbPath: String?
    var port = 3032
    var threadCount = max(2, System.coreCount - 2)
    var benchIters: Int?
    var args = CommandLine.arguments.dropFirst().makeIterator()
    while let arg = args.next() {
      switch arg {
      case "--db": dbPath = args.next()
      case "--port": if let v = args.next(), let p = Int(v) { port = p }
      case "--threads": if let v = args.next(), let t = Int(v) { threadCount = max(1, t) }
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

    // A small event-loop group: blocking reads run on the NIOThreadPool, so
    // the loops only do IO/framing. Sizing the ELG = coreCount would
    // oversubscribe cores against the pool + the Swift cooperative executor.
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 2)
    let serverChannel = try await ServerBootstrap(group: group)
      .serverChannelOption(ChannelOptions.backlog, value: 256)
      .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
      // TCP_NODELAY: without it, Nagle's algorithm + delayed ACKs add
      // multi-ms latency to small keep-alive responses (Bun.serve sets this
      // by default; matching it is required for a fair comparison).
      .childChannelOption(ChannelOptions.socketOption(.tcp_nodelay), value: 1)
      .bind(host: "127.0.0.1", port: port) { childChannel in
        childChannel.eventLoop.makeCompletedFuture {
          try childChannel.pipeline.syncOperations.configureHTTPServerPipeline()
          return try NIOAsyncChannel<HTTPServerRequestPart, HTTPServerResponsePart>(
            wrappingChannelSynchronously: childChannel)
        }
      }

    print("ad-server listening on 127.0.0.1:\(port) (threads=\(threadCount))")
    // Structured: each connection is a child task of the accept loop
    // (DiscardingTaskGroup auto-reaps completed connections — macOS 15+).
    try await withThrowingDiscardingTaskGroup { group in
      try await serverChannel.executeThenClose { inbound in
        for try await childChannel in inbound {
          group.addTask { await serveConnection(childChannel, pool: pool, threadPool: threadPool) }
        }
      }
    }
  }
}
