import AemiJSONRPC
public import Foundation

/// Cross-platform stdio JSON-RPC 2.0 transport runner for `apple-docs mcp`.
///
/// Reads newline-delimited JSON-RPC frames from standard input using `AemiJSONRPC.LineFraming`
/// (with a 1 MiB line cap matching Streamable HTTP) and writes framed responses atomically to
/// standard output. Never prints diagnostic logs to stdout.
public enum MCPStdioTransport: Sendable {
    /// Maximum accepted single-line JSON-RPC payload size on stdio (1 MiB).
    public static let maxLineBytes = 1_048_576

    /// Runs the stdio loop until EOF on `input`, writing framed replies to `output`.
    public static func run(
        dispatcher: MCPServerDispatcher,
        input: FileHandle? = nil,
        output: FileHandle? = nil
    ) async throws {
        let reader = input ?? .standardInput
        let writer = output ?? .standardOutput
        var framing = LineFraming(maximumLineLength: maxLineBytes)
        while true {
            // `availableData` returns as soon as any bytes arrive (empty at EOF); `read(upToCount:)` would
            // wait for a full buffer and starve interactive clients that keep stdin open between requests.
            let chunk = reader.availableData
            guard !chunk.isEmpty else { break }
            let lines = framing.append(chunk)
            for line in lines {
                switch line {
                    case .tooLong:
                        let err = JSONRPCError(
                            code: JSONRPCError.parseError,
                            message: "Line exceeds maximum length of \(maxLineBytes) bytes."
                        )
                        if let bytes = try? JSONRPC.response(id: nil, error: err) {
                            try writer.write(contentsOf: LineFraming.frame(bytes))
                        }
                    case .message(let body):
                        if let reply = await dispatcher.handleRawPayload(body) {
                            try writer.write(contentsOf: LineFraming.frame(reply))
                        }
                }
            }
        }
    }
}
