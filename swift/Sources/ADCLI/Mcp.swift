// `ad-cli mcp install` — print MCP client configuration for apple-docs (the
// config-writer half of cli.js's `mcp` verb; `mcp start` / `mcp serve` are the
// native ad-server, which owns the protocol). Pure stdout, no corpus. Ports
// cli.js:264-331 (the stdio config + the `--http` Streamable-HTTP variant).

import ADJSONCore
import ArgumentParser
import Foundation

/// `ad-cli mcp …` — the CLI-side MCP verb group (config only; the server is ad-server).
struct McpCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "mcp", abstract: "MCP client configuration (install).",
        subcommands: [McpInstallCommand.self])
}

/// `ad-cli mcp install [--http [--endpoint <url>]] [--home <dir>]` — print the
/// `mcpServers` config blocks a client drops into its settings.
struct McpInstallCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "install", abstract: "Print MCP server configuration for apple-docs clients.")

    @Flag(name: .long, help: "Emit a Streamable-HTTP client config, not the stdio config.")
    var http = false

    @Option(name: .long, help: "Streamable-HTTP endpoint URL (with --http). Defaults to a placeholder.")
    var endpoint: String?

    @Option(name: .long, help: "APPLE_DOCS_HOME to embed in the config (default: env or ~/.apple-docs).")
    var home: String?

    func run() {
        if http {
            let url = endpoint ?? "https://apple-docs-mcp.example.com/mcp"
            print("MCP (Streamable HTTP) client configuration for apple-docs:\n")
            print(
                stringifyPretty(
                    mcpServers([("transport", .obj([("type", .string("streamable-http")), ("url", .string(url))]))])))
            print("\nFallback for clients without native Streamable HTTP support (via mcp-remote):")
            print(
                stringifyPretty(
                    mcpServers([("command", .string("npx")), ("args", .array([.string("mcp-remote"), .string(url)]))])))
            return
        }

        let dataDir = home ?? ProcessInfo.processInfo.environment["APPLE_DOCS_HOME"] ?? defaultHome()
        print("MCP server configuration for apple-docs:\n")
        print(
            stringifyPretty(
                mcpServers([
                    ("command", .string("apple-docs")),
                    ("args", .array([.string("mcp"), .string("start")])),
                    ("env", .obj([("APPLE_DOCS_HOME", .string(dataDir))]))
                ])))
        print("\nAlternatively, use the backward-compatible binary:")
        print(
            stringifyPretty(
                mcpServers([
                    ("command", .string("apple-docs-mcp")),
                    ("env", .obj([("APPLE_DOCS_HOME", .string(dataDir))]))
                ])))
    }

    /// `{ "mcpServers": { "apple-docs": { …entries } } }` — the fixed envelope.
    private func mcpServers(_ entries: [(String, JSONValue)]) -> JSONValue {
        .obj([("mcpServers", .obj([("apple-docs", .obj(entries))]))])
    }

    /// `~/.apple-docs` — the default corpus home when neither --home nor the env is set.
    private func defaultHome() -> String {
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        return "\(home)/.apple-docs"
    }
}
