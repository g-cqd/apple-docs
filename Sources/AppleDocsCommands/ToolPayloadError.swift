/// A tool-level failure reported to MCP clients as an `isError` result carrying `message` (Bun's
/// `ValidationError` / `NotFoundError`).
public struct ToolPayloadError: Error, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}
