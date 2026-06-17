// ad-server — the app host. Parses flags into the engine configuration + siteConfig,
// opens the connection pool, and runs the ADServeCore HTTP engine against the
// DSL-declared route table (Endpoints.swift). The serving machinery (NIO, the response
// envelope, the offload) lives in ADServeCore; this is just the app's composition root.
// Subcommands: `serve` (default), `mcp`, `bench`.

import ADServeCore
import ADServeDSL
import ADStorage
import ArgumentParser
import Dispatch
import Foundation
import Logging

@main
struct ADServerCommand: AsyncParsableCommand {
  static let configuration = CommandConfiguration(
    commandName: "ad-server",
    abstract: "Apple Docs native HTTP + MCP host.",
    subcommands: [ServeCommand.self, MCPCommand.self, BenchCommand.self],
    defaultSubcommand: ServeCommand.self)
}

/// The corpus path — every subcommand opens it.
struct CorpusOptions: ParsableArguments {
  @Option(name: .long, help: "Path to the corpus SQLite database.")
  var db: String

  func validate() throws {
    guard !db.isEmpty else { throw ValidationError("--db must not be empty") }
  }
}

/// `ad-server [serve]` — the HTTP engine over the DSL route table (the default).
struct ServeCommand: AsyncParsableCommand {
  static let configuration = CommandConfiguration(
    commandName: "serve", abstract: "Run the HTTP server (default).")

  @OptionGroup var corpus: CorpusOptions

  @Option(help: "Loopback plaintext listen port.")
  var port = 3032
  @Option(help: "Reader-pool connection count.")
  var threads = max(2, ProcessInfo.processInfo.activeProcessorCount - 2)
  @Option(help: "NIO event-loop count.")
  var loops = 2
  @Option(name: .customLong("tls-cert"), help: "PEM certificate chain (with --tls-key ⇒ in-process TLS).")
  var tlsCert: String?
  @Option(name: .customLong("tls-key"), help: "PEM private key (with --tls-cert ⇒ in-process TLS).")
  var tlsKey: String?
  @Option(name: .customLong("tls-port"), help: "In-process TLS listen port.")
  var tlsPort = 8443
  @Option(help: "Engine transport: nio or network.")
  var transport = EngineTransport.nio.rawValue
  @Option(name: .customLong("base-url"), help: "Public base URL for discovery documents.")
  var baseURL: String?
  @Option(name: .customLong("site-name"))
  var siteName: String?
  @Option(name: .customLong("search-short-name"))
  var searchShortName: String?
  @Option(name: .customLong("content-signal"))
  var contentSignal: String?
  @Option(name: .customLong("app-version"))
  var appVersion: String?

  func validate() throws {
    guard EngineTransport(rawValue: transport) != nil else {
      throw ValidationError("--transport must be 'nio' or 'network'")
    }
  }

  func run() async throws {
    let dbPath = corpus.db
    let threadCount = max(1, threads)
    let loopCount = max(1, loops)
    let engineTransport = EngineTransport(rawValue: transport) ?? .nio

    var siteConfig = SiteConfig()
    if let baseURL { siteConfig.baseUrl = baseURL }
    if let siteName { siteConfig.siteName = siteName }
    if let searchShortName { siteConfig.searchShortName = searchShortName }
    if let contentSignal { siteConfig.contentSignal = contentSignal }
    if let appVersion { siteConfig.appVersion = appVersion }

    guard let pool = ConnectionPool(path: dbPath, count: threadCount) else {
      fail("ad-server: cannot open \(dbPath) — libsqlite3/FTS5 unavailable?", code: 1)
    }

    var logger = Logger(label: "ad-server")
    logger.logLevel = .info

    // The MCP dispatcher is shared by the HTTP `/mcp` transport (per-request pooled
    // connection) and the stdio mode (a fixed connection).
    let dispatcher = MCPDispatcher(
      serverInfo: mcpServerInfo(version: siteConfig.appVersion), tools: mcpToolRegistry())
    // Both cert + key present ⇒ an in-process TLS listener on `tlsPort` (the "Both" model);
    // else the loopback plaintext listener alone (Caddy terminates TLS in production).
    let tls: TLSSource? =
      if let tlsCert, let tlsKey { .pem(certificate: tlsCert, privateKey: tlsKey) } else { nil }
    let readiness = ServerReadiness()
    let server = HTTPServer(
      listeners: listeners(
        endpoints(
          config: siteConfig, mcpDispatcher: dispatcher, tls: tls, tlsPort: tlsPort,
          readiness: readiness),
        defaultPort: port),
      pool: pool,
      envelope: buildEnvelope(),
      logger: logger,
      threadCount: threadCount,
      loopCount: loopCount,
      readiness: readiness,
      transport: engineTransport)
    try await server.run()
  }
}

/// `ad-server mcp` — the stdio MCP server (one serial client; no HTTP).
/// Logs go to STDERR so STDOUT carries only JSON-RPC.
struct MCPCommand: ParsableCommand {
  static let configuration = CommandConfiguration(
    commandName: "mcp", abstract: "Run the stdio MCP server.")

  @OptionGroup var corpus: CorpusOptions

  @Option(name: .customLong("app-version"))
  var appVersion: String?

  func run() throws {
    let version = appVersion ?? SiteConfig().appVersion
    LoggingSystem.bootstrap(StreamLogHandler.standardError)
    guard let connection = StorageConnection(path: corpus.db) else {
      fail("ad-server: cannot open \(corpus.db)", code: 1)
    }
    var logger = Logger(label: "ad-server-mcp")
    logger.logLevel = .info
    let dispatcher = MCPDispatcher(serverInfo: mcpServerInfo(version: version), tools: mcpToolRegistry())
    let context = MCPToolContext(connection: connection, logger: logger)
    StdioMCPTransport(dispatcher: dispatcher, context: context).run()
  }
}

/// `ad-server bench ITERS` — time searchPagesJSON in-process (no NIO/offload/HTTP)
/// to isolate the read+JSON cost from the serving machinery.
struct BenchCommand: ParsableCommand {
  static let configuration = CommandConfiguration(
    commandName: "bench", abstract: "Time searchPagesJSON in-process.")

  @OptionGroup var corpus: CorpusOptions

  @Argument(help: "Iteration count.")
  var iters: Int

  func run() throws {
    guard let conn = StorageConnection(path: corpus.db) else {
      fail("ad-server: cannot open \(corpus.db)", code: 1)
    }
    let params = parseSearchParams("/search?q=view&framework=swiftui&limit=100")
    for _ in 0..<500 { _ = conn.searchPagesJSON(params) }
    let t0 = DispatchTime.now().uptimeNanoseconds
    for _ in 0..<iters { _ = conn.searchPagesJSON(params) }
    let ns = (DispatchTime.now().uptimeNanoseconds - t0) / UInt64(max(1, iters))
    print("searchPagesJSON in-process: \(ns) ns/call (\(Double(ns) / 1000.0) µs, \(iters) iters)")
  }
}

/// Write a message to stderr and exit.
private func fail(_ message: String, code: Int32) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(code)
}
