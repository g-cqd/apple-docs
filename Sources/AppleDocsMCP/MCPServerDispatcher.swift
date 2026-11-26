public import AemiJSONCore
public import AemiJSONRPC
import AppleDocsCommands
import AppleDocsCore
import OrderedCollections

/// Cross-platform MCP server dispatcher handling JSON-RPC 2.0 requests (`initialize`, `ping`,
/// `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`)
/// against a pooled read-only ``CorpusReaderHandle``, bounded LRU cache, and render semaphore.
public final class MCPServerDispatcher: Sendable {
    /// Supported MCP protocol version advertised during `initialize`.
    public static let protocolVersion = "2025-03-26"

    let reader: CorpusReaderHandle
    let markdownCache: BoundedLRUCache<String, String>
    let renderPermits: AsyncPermitPool

    /// Creates a dispatcher backed by `databasePath` with bounded reader pool, LRU cache, and render concurrency cap.
    public init(
        databasePath: String,
        resourcesDirectory: String? = nil,
        maxReaders: Int = 4,
        cacheCapacity: Int = 256,
        maxConcurrentRenders: Int = 4
    ) {
        self.reader = CorpusReaderHandle(
            databasePath: databasePath,
            resourcesDirectory: resourcesDirectory,
            maxReaders: maxReaders
        )
        self.markdownCache = BoundedLRUCache(capacity: cacheCapacity)
        self.renderPermits = AsyncPermitPool(limit: maxConcurrentRenders)
    }

    /// Closes pooled SQLite readers and clears caches cleanly on shutdown.
    public func close() async {
        await markdownCache.removeAll()
        await reader.close()
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
            case "resources/list":
                return await handleResourcesList()
            case "resources/templates/list":
                return .success(resourceTemplatesResult())
            case "resources/read":
                return await handleResourceRead(request.params)
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
                "tools": .object(["listChanged": .bool(false)]),
                "resources": .object(["subscribe": .bool(false), "listChanged": .bool(false)])
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
                "description": .string(descriptor.description),
                "annotations": .object([
                    "readOnlyHint": .bool(descriptor.isReadOnly),
                    "destructiveHint": .bool(false),
                    "idempotentHint": .bool(true),
                    "openWorldHint": .bool(false)
                ]),
                "inputSchema": descriptor.inputSchema
            ])
        }
        return .object(["tools": .array(toolObjects)])
    }
}
