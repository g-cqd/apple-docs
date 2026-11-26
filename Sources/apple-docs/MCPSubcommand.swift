import AppleDocsCommands
import AppleDocsCore
import AppleDocsMCP
import AppleDocsOutput
import AppleDocsSearch
import AppleDocsStorage
import ArgumentParser

/// `apple-docs mcp` command group (`stdio` default, plus `serve` for Streamable HTTP on `g-cqd/HTTP`).
struct MCPSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "mcp",
        abstract: "Run the MCP JSON-RPC 2.0 server (stdio by default, or 'serve' for HTTP).",
        subcommands: [MCPServeSubcommand.self]
    )

    @Option(name: .long, help: "Override corpus database path.") var db: String?

    func run() async throws {
        let dispatcher = MCPServerDispatcher(databasePath: db ?? CorpusPaths.defaultDatabasePath())
        do {
            try await MCPStdioTransport.run(dispatcher: dispatcher)
            await dispatcher.close()
        } catch {
            await dispatcher.close()
            throw error
        }
    }
}

private struct MCPServeSubcommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "serve",
        abstract: "Serve MCP over Streamable HTTP (POST /mcp) via g-cqd/HTTP."
    )

    @Option(name: .long, help: "Bind host address.") var host = "127.0.0.1"
    @Option(name: .long, help: "TCP listen port.") var port: UInt16 = 3_133
    @Option(name: .long, help: "Additional allowed Origin headers.") var allowOrigin: [String] = []
    @Option(name: .long, help: "Override corpus database path.") var db: String?

    func run() async throws {
        let dispatcher = MCPServerDispatcher(databasePath: db ?? CorpusPaths.defaultDatabasePath())
        let origins = Set(allowOrigin.map { $0.lowercased() })
        try await MCPHTTPServer.serve(
            dispatcher: dispatcher,
            host: host,
            port: port,
            allowedOrigins: origins
        )
    }
}
