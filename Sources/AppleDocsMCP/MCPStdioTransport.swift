import AemiMCP
public import Foundation

/// Cross-platform stdio JSON-RPC 2.0 transport runner for `apple-docs mcp`, on AemiMCP's `MCPStdioServer`.
///
/// Reads newline-delimited JSON-RPC frames from standard input (with a 1 MiB line cap matching Streamable HTTP), serves up
/// to ``maxConcurrentRequests`` at once so a `notifications/cancelled` reaches an in-flight call, and writes each framed
/// response whole to standard output. Never prints diagnostic logs to stdout.
public enum MCPStdioTransport: Sendable {
    /// Maximum accepted single-line JSON-RPC payload size on stdio (1 MiB).
    public static let maxLineBytes = 1_048_576
    /// The most requests served at once: the reader pool's default size.
    public static let maxConcurrentRequests = 4

    /// Runs the stdio loop until EOF on `input`, writing framed replies to `output`.
    public static func run(
        dispatcher: MCPServerDispatcher,
        input: FileHandle? = nil,
        output: FileHandle? = nil
    ) async throws {
        dispatcher.prewarm()
        await MCPStdioServer.serve(
            dispatcher.protocolHandler,
            inputDescriptor: (input ?? .standardInput).fileDescriptor,
            outputDescriptor: (output ?? .standardOutput).fileDescriptor,
            maximumLineLength: maxLineBytes,
            maxConcurrentRequests: maxConcurrentRequests
        )
    }
}
