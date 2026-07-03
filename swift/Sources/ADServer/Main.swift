// ad-server — the app host. Parses flags into the engine configuration + siteConfig,
// opens the connection pool, and runs the ADServeCore HTTP engine against the
// DSL-declared route table (Endpoints.swift). The serving machinery (NIO, the response
// envelope, the offload) lives in ADServeCore; this is just the app's composition root.
// Subcommands: `serve` (default), `mcp`, `bench`.

import ADConcurrency
import ADServeCore
import ADServeDSL
import ADStorage
import ArgumentParser
import Dispatch
import Foundation
import Logging
import Synchronization

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
    @Option(help: "Engine transport: posix or network (nio remains a deprecated alias of posix).")
    var transport = EngineTransport.posix.rawValue
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
        let engineTransport = EngineTransport(rawValue: transport) ?? .posix

        var siteConfig = SiteConfig()
        if let baseURL { siteConfig.baseUrl = baseURL }
        if let siteName { siteConfig.siteName = siteName }
        if let searchShortName { siteConfig.searchShortName = searchShortName }
        if let contentSignal { siteConfig.contentSignal = contentSignal }
        if let appVersion { siteConfig.appVersion = appVersion }

        guard let pool = AnyConnectionPool.storage(path: dbPath, count: threadCount) else {
            fail("ad-server: cannot open \(dbPath) — libsqlite3/FTS5 unavailable?", code: 1)
        }

        var logger = Logger(label: "ad-server")
        logger.logLevel = .info

        // The MCP dispatcher is shared by the HTTP `/mcp` transport (per-request pooled
        // connection) and the stdio mode (a fixed connection).
        let dispatcher = MCPDispatcher(
            serverInfo: mcpServerInfo(version: siteConfig.appVersion), tools: mcpToolRegistry(),
            resources: mcpResourceRegistry())
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
        // SIGTERM/SIGINT shutdown ownership. ADServeCore's ServiceGroup traps
        // these via SIG_IGN + kqueue (DispatchSourceSignal), but with the
        // engine-swap ADServe + service-lifecycle 2.11.0 on the macOS 27 beta
        // toolchain that path is BROKEN TWICE OVER, observed 2026-07-03:
        //   1. Delivery is mask-distribution-dependent — Bun.spawn children
        //      inherit SIGTERM blocked in every thread, so the signal stays
        //      pending forever: kqueue sources and sigaction handlers never
        //      see it and the release server survives SIGTERM indefinitely
        //      (the exact failure the graceful-shutdown gate caught).
        //   2. When delivery DOES occur, the group's drain has been observed
        //      to hang after "draining (stop accepting)" — the ServiceGroup
        //      never returns, so run() never reaches its teardown.
        // Main therefore owns shutdown, defense-in-depth (see
        // installShutdownOwner): a self-pipe sigaction handler for clear-mask
        // environments, a sigwait watcher for blocked-mask ones, and a bounded
        // hard-exit escalation for the drain hang. The library path still runs
        // when it can; whoever finishes first wins, the result is identical:
        // readiness off, teardown, exit 0.
        let serveTask = Task { try await server.run() }
        installShutdownOwner(readiness: readiness) { serveTask.cancel() }
        try await serveTask.value
    }
}

/// The self-pipe write end for the shutdown handler. Written from an
/// async-signal context, read by the watcher thread; set ONCE (before the
/// sigaction install) and never mutated again, which is what makes the
/// unsynchronized global safe.
private nonisolated(unsafe) var shutdownPipeWriteEnd: Int32 = -1

/// Installs the SIGTERM/SIGINT owner: a minimal C-convention handler writing
/// to a self-pipe, a sigwait watcher for blocked-mask spawns, a re-armer that
/// keeps the handler final over the library's later SIG_IGN, and the ordered
/// teardown (not-ready → 1 s drain window → cancel → 1.5 s → hard exit 0).
private func installShutdownOwner(
    readiness: ServerReadiness, cancelServe: @escaping @Sendable () -> Void
) {
    var ends: [Int32] = [-1, -1]
    guard pipe(&ends) == 0 else { return }  // no pipe ⇒ no owner; the library trap remains
    shutdownPipeWriteEnd = ends[1]
    let readEnd = ends[0]

    installPipeHandler()

    let shutdownStarted = Atomic<Bool>(false)
    let orchestrate: @Sendable () -> Void = {
        // Once-only: whichever waiter wins runs the teardown.
        guard !shutdownStarted.exchange(true, ordering: .acquiringAndReleasing) else { return }
        readiness.set(false)
        Thread.sleep(forTimeInterval: 1)
        cancelServe()
        // Escalation: cancellation makes ServiceGroup gracefully shut its
        // services down, and the rebased engine's drain has been observed to
        // HANG there (drain log line, then nothing — the group never returns).
        // If the cooperative teardown hasn't exited the process within the
        // window, deliver the operator contract directly: the corpus is
        // read-only and readiness has been off since the signal, so a hard
        // exit 0 loses nothing but lingering sockets.
        Thread.sleep(forTimeInterval: 1.5)
        exit(0)
    }

    // Waiter 1 — CLEAR-MASK environments (launchd, a plain shell): the kernel
    // delivers the process-directed signal to some unblocked thread, the
    // sigaction handler fires there and writes the pipe; this thread reads it
    // IMMEDIATELY (the re-armer below is separate so no arm delay adds to the
    // shutdown latency).
    Thread.detachNewThread {
        Thread.current.name = "shutdown-owner-pipe"
        var byte: UInt8 = 0
        while read(readEnd, &byte, 1) == -1 && errno == EINTR { continue }
        orchestrate()
    }

    // Re-armer — ServiceGroup's own trap (`signal(sig, SIG_IGN)` inside
    // `HTTPServer.run()`) races the handler install and would REPLACE it with
    // IGN; a clear-mask SIGTERM landing while IGN holds is discarded WITHOUT A
    // TRACE (measured: kill right after readyz = swallowed forever; kill after
    // a 3 s settle = clean 2.5 s exit). The library installs once, in the
    // first moments of the serve task, so re-arm at 10 ms cadence through the
    // startup phase (shrinking the IGN exposure to sub-tick slivers), then at
    // a slow forever tick as insurance. A parked thread doing a few hundred
    // sigactions costs nothing.
    Thread.detachNewThread {
        Thread.current.name = "shutdown-owner-rearm"
        for _ in 0 ..< 300 {
            Thread.sleep(forTimeInterval: 0.01)
            installPipeHandler()
        }
        while true {
            Thread.sleep(forTimeInterval: 1)
            installPipeHandler()
        }
    }

    // Waiter 2 — BLOCKED-MASK environments (observed: Bun.spawn children
    // inherit SIGTERM blocked in EVERY thread, so the signal stays pending
    // forever and neither sigaction handlers nor kqueue sources ever see it).
    // `sigwait` dequeues the pending process-directed signal synchronously,
    // disposition and delivery notwithstanding.
    Thread.detachNewThread {
        Thread.current.name = "shutdown-owner-sigwait"
        var set = sigset_t()
        sigemptyset(&set)
        sigaddset(&set, SIGTERM)
        sigaddset(&set, SIGINT)
        pthread_sigmask(SIG_BLOCK, &set, nil)
        var which: Int32 = 0
        while sigwait(&set, &which) != 0 { continue }
        orchestrate()
    }

    // Waiter 3 — readiness-drop watcher. Covers the one remaining hole: a
    // clear-mask signal landing in a re-arm gap (the library's SIG_IGN
    // momentarily holding), where the library's OWN kqueue path starts the
    // drain — and then hangs in the rebased engine with no orchestrator alive
    // to finish the job. Readiness only ever drops during a shutdown (it is
    // set true once, at bind), so true→false is a reliable "shutdown began
    // somewhere" edge; the once-only orchestrate makes the overlap harmless.
    Thread.detachNewThread {
        Thread.current.name = "shutdown-owner-readiness"
        var wasReady = false
        while true {
            Thread.sleep(forTimeInterval: 0.1)
            let ready = readiness.isReady
            if wasReady && !ready {
                orchestrate()
                return
            }
            wasReady = wasReady || ready
        }
    }
}

/// (Re)installs the async-signal-safe self-pipe handler for SIGTERM/SIGINT.
private func installPipeHandler() {
    var action = sigaction()
    action.__sigaction_u.__sa_handler = { _ in
        // Async-signal-safe: one write, no allocation, no locks.
        var byte: UInt8 = 1
        _ = write(shutdownPipeWriteEnd, &byte, 1)
    }
    sigemptyset(&action.sa_mask)
    action.sa_flags = 0
    sigaction(SIGTERM, &action, nil)
    sigaction(SIGINT, &action, nil)
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
        let dispatcher = MCPDispatcher(
            serverInfo: mcpServerInfo(version: version), tools: mcpToolRegistry(),
            resources: mcpResourceRegistry())
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
        guard let params = parseSearchParams("/search?q=view&framework=swiftui&limit=100") else {
            fail("ad-server: failed to parse benchmark query", code: 1)
        }
        for _ in 0 ..< 500 { _ = conn.searchPagesJSON(params) }
        let t0 = DispatchTime.now().uptimeNanoseconds
        for _ in 0 ..< iters { _ = conn.searchPagesJSON(params) }
        let ns = (DispatchTime.now().uptimeNanoseconds - t0) / UInt64(max(1, iters))
        print("searchPagesJSON in-process: \(ns) ns/call (\(Double(ns) / 1000.0) µs, \(iters) iters)")
    }
}

/// Write a message to stderr and exit.
private func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}
