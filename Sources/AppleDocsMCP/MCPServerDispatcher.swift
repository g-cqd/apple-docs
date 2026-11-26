public import AemiJSONCore
public import AemiJSONRPC
import AppleDocsCore
import AppleDocsStorage
import OrderedCollections

/// Cross-platform MCP server dispatcher handling JSON-RPC 2.0 requests (`initialize`, `ping`,
/// `tools/list`, `tools/call`) against a pooled read-only ``SQLiteReaderPool``.
///
/// Transport-agnostic: drives both `stdio` (via ``MCPStdioTransport``) and Streamable HTTP
/// (via ``MCPHTTPResponder`` on `g-cqd/HTTP`).
public final class MCPServerDispatcher: Sendable {
    /// Supported MCP protocol version advertised during `initialize`.
    public static let protocolVersion = "2025-03-26"

    let pool: SQLiteReaderPool
    let databasePath: String

    /// Creates a dispatcher backed by `databasePath` with a bounded reader pool.
    public init(databasePath: String, maxReaders: Int = 4) {
        self.databasePath = databasePath
        self.pool = SQLiteReaderPool(path: databasePath, maxReaders: maxReaders)
    }

    /// Closes pooled SQLite readers cleanly on shutdown.
    public func close() async {
        await pool.close()
    }

    /// Evaluates one raw JSON-RPC 2.0 payload byte array and returns encoded response bytes
    /// (`nil` for notifications that require no response).
    public func handleRawPayload(_ body: [UInt8]) async -> [UInt8]? {
        let message: JSONRPCMessage
        do {
            message = try JSONRPCMessage(parsing: body)
        } catch {
            return try? error.response()
        }
        switch message {
            case .notification:
                return nil
            case .response:
                let err = JSONRPCError(code: JSONRPCError.invalidRequest, message: "Server does not accept responses.")
                return try? JSONRPC.response(id: nil, error: err)
            case .request(let request):
                let outcome = await dispatch(request)
                switch outcome {
                    case .success(let value):
                        return try? JSONRPC.response(id: request.id, result: value)
                    case .failure(let error):
                        return try? JSONRPC.response(id: request.id, error: error)
                }
        }
    }

    /// Dispatches one parsed ``JSONRPCRequest`` into an MCP protocol result or error.
    public func dispatch(_ request: JSONRPCRequest) async -> Result<JSONValue, JSONRPCError> {
        switch request.method {
            case "initialize":
                return .success(initializeResult())
            case "ping":
                return .success(.object([:]))
            case "tools/list":
                return .success(toolsListResult())
            case "tools/call":
                return await handleToolCall(request.params)
            default:
                return .failure(
                    JSONRPCError(code: JSONRPCError.methodNotFound, message: "Unknown method: \(request.method)")
                )
        }
    }

    private func initializeResult() -> JSONValue {
        .object([
            "protocolVersion": .string(Self.protocolVersion),
            "capabilities": .object([
                "tools": .object(["listChanged": .bool(false)])
            ]),
            "serverInfo": .object([
                "name": .string("apple-docs"),
                "version": .string(AppleDocsVersion.current)
            ])
        ])
    }

    private func toolsListResult() -> JSONValue {
        let toolObjects: [JSONValue] = MCPToolDescriptor.allTools.map { descriptor in
            .object([
                "name": .string(descriptor.name),
                "annotations": .object([
                    "readOnlyHint": .bool(descriptor.isReadOnly),
                    "destructiveHint": .bool(false),
                    "idempotentHint": .bool(true),
                    "openWorldHint": .bool(false)
                ]),
                "inputSchema": .object(["type": .string("object")])
            ])
        }
        return .object(["tools": .array(toolObjects)])
    }
}
