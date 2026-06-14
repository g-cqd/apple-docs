// ad-server — the RFC 0001 P6 / RFC 0005 host. Parses flags into the engine
// configuration + siteConfig, opens the connection pool, and runs the ADServeCore
// HTTP engine against the DSL-declared route table (Endpoints.swift). The serving
// machinery (NIO, the response envelope, the offload) lives in ADServeCore; this is
// just the app's composition root. `--bench` keeps the in-process read diagnostic.

import ADServeCore
import ADServeDSL
import ADStorage
import Dispatch
import Foundation
import Logging

@main
struct ADServerMain {
  static func main() async throws {
    var dbPath: String?
    var port = 3032
    var threadCount = max(2, ProcessInfo.processInfo.activeProcessorCount - 2)
    var loopCount = 2
    var benchIters: Int?
    var siteConfig = SiteConfig()
    // `ad-server mcp …` runs the stdio MCP server; otherwise the HTTP server.
    var rawArgs = Array(CommandLine.arguments.dropFirst())
    let mcpMode = rawArgs.first == "mcp"
    if mcpMode { rawArgs.removeFirst() }
    var args = rawArgs.makeIterator()
    while let arg = args.next() {
      switch arg {
      case "--db": dbPath = args.next()
      case "--port": if let v = args.next(), let p = Int(v) { port = p }
      case "--threads": if let v = args.next(), let t = Int(v) { threadCount = max(1, t) }
      case "--loops": if let v = args.next(), let l = Int(v) { loopCount = max(1, l) }
      case "--bench": if let v = args.next(), let n = Int(v) { benchIters = n }
      case "--base-url": if let v = args.next() { siteConfig.baseUrl = v }
      case "--site-name": if let v = args.next() { siteConfig.siteName = v }
      case "--search-short-name": if let v = args.next() { siteConfig.searchShortName = v }
      case "--content-signal": if let v = args.next() { siteConfig.contentSignal = v }
      case "--app-version": if let v = args.next() { siteConfig.appVersion = v }
      default: break
      }
    }
    guard let dbPath, !dbPath.isEmpty else {
      fail(
        "usage: ad-server [mcp] --db <corpus.db> [--port 3032] [--threads N] [--loops N] [--bench ITERS]",
        code: 2)
    }

    // `ad-server mcp` — the stdio MCP server (one serial client; no HTTP).
    if mcpMode {
      runMCP(dbPath: dbPath, version: siteConfig.appVersion)
      return
    }

    // Diagnostic: time searchPagesJSON in-process (no NIO/offload/HTTP) to isolate the
    // read+JSON cost from the serving machinery.
    if let iters = benchIters {
      runBench(dbPath: dbPath, iters: iters)
      return
    }

    guard let pool = ConnectionPool(path: dbPath, count: threadCount) else {
      fail("ad-server: cannot open \(dbPath) — libsqlite3/FTS5 unavailable?", code: 1)
    }

    var logger = Logger(label: "ad-server")
    logger.logLevel = .info

    // The MCP dispatcher is shared by the HTTP `/mcp` transport (per-request pooled
    // connection) and the stdio mode (a fixed connection).
    let dispatcher = MCPDispatcher(
      serverInfo: mcpServerInfo(version: siteConfig.appVersion), tools: mcpToolRegistry())
    let server = HTTPServer(
      configuration: ServerConfiguration(port: port, threadCount: threadCount, loopCount: loopCount),
      pool: pool,
      routes: endpoints(config: siteConfig, mcpDispatcher: dispatcher),
      envelope: buildEnvelope(),
      logger: logger)
    try await server.run()
  }

  private static func runBench(dbPath: String, iters: Int) {
    guard let conn = StorageConnection(path: dbPath) else {
      fail("ad-server: cannot open \(dbPath)", code: 1)
    }
    let params = parseSearchParams("/search?q=view&framework=swiftui&limit=100")
    for _ in 0..<500 { _ = conn.searchPagesJSON(params) }
    let t0 = DispatchTime.now().uptimeNanoseconds
    for _ in 0..<iters { _ = conn.searchPagesJSON(params) }
    let ns = (DispatchTime.now().uptimeNanoseconds - t0) / UInt64(max(1, iters))
    print("searchPagesJSON in-process: \(ns) ns/call (\(Double(ns) / 1000.0) µs, \(iters) iters)")
  }

  /// Runs the stdio MCP server. Logs go to STDERR so STDOUT carries only JSON-RPC.
  private static func runMCP(dbPath: String, version: String) {
    LoggingSystem.bootstrap(StreamLogHandler.standardError)
    guard let connection = StorageConnection(path: dbPath) else {
      fail("ad-server: cannot open \(dbPath)", code: 1)
    }
    var logger = Logger(label: "ad-server-mcp")
    logger.logLevel = .info
    let dispatcher = MCPDispatcher(serverInfo: mcpServerInfo(version: version), tools: mcpToolRegistry())
    let context = MCPToolContext(connection: connection, logger: logger)
    StdioMCPTransport(dispatcher: dispatcher, context: context).run()
  }
}

/// Write a message to stderr and exit.
private func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}
