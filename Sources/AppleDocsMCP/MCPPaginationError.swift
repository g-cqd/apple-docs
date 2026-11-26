/// Bun's `ValidationError` for pagination arguments (surfaced to MCP clients as an invalid-params error).
struct MCPPaginationError: Error, Equatable, Sendable {
    let message: String
}
