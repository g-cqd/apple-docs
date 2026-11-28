public import AemiJSONCore
public import AemiJSONRPC
import AemiMCP
import AppleDocsCommands
import AppleDocsCore
import Foundation
import OrderedCollections
import Synchronization

/// Cross-platform MCP server dispatcher handling JSON-RPC 2.0 requests (`initialize`, `ping`,
/// `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`)
/// against a pooled read-only ``CorpusReaderHandle``, bounded LRU cache, and render semaphore.
///
/// The protocol (version negotiation, cancellation, strict JSON-RPC) is AemiMCP's `MCPServer`; this type owns the tools
/// and resources.
public final class MCPServerDispatcher: Sendable {
    /// The MCP protocol version answered when the client offers none, or one this server does not speak (the Bun
    /// server's).
    public static let protocolVersion = "2025-03-26"
    /// Every version this server speaks: the default first, then the others AemiMCP knows, newest first. A client offering
    /// one of them gets it back.
    public static let protocolVersions =
        [protocolVersion] + MCPProtocolVersion.supported.filter { $0 != protocolVersion }

    let reader: CorpusReaderHandle
    let markdownCache: BoundedLRUCache<String, String>
    let renderPermits: AsyncPermitPool
    /// Tool result cache (`nil` when `APPLE_DOCS_MCP_CACHE=off`).
    let toolCache: MCPToolCache?
    /// The protocol server, its handlers answered by this dispatcher; set once at the end of `init`.
    private let protocolServer = ProtocolServerSlot()

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
        let stamp = CorpusStamp(databasePath: databasePath)
        self.toolCache =
            ProcessInfo.processInfo.environment["APPLE_DOCS_MCP_CACHE"] == "off"
            ? nil
            : MCPToolCache(stamp: { stamp.current() }, now: { CorpusStamp.monotonicMilliseconds() })
        protocolServer.install(makeProtocolServer())
    }

    /// Starts background warmup of the semantic index (`Model2VecEmbedder` + `ChunkVectorStore`).
    public func prewarm() {
        reader.prewarmSemantic()
    }

    /// Closes pooled SQLite readers and clears caches cleanly on shutdown.
    public func close() async {
        await markdownCache.removeAll()
        await reader.close()
    }

    /// Evaluates one raw JSON-RPC 2.0 payload byte array and returns encoded response bytes
    /// (`nil` for notifications, responses and cancelled requests).
    public func handleRawPayload(_ body: [UInt8]) async -> [UInt8]? {
        await protocolServer.server.handle(body)
    }

    /// Dispatches one parsed ``JSONRPCRequest`` into an MCP protocol result or error.
    public func dispatch(_ request: JSONRPCRequest) async -> Result<JSONValue, JSONRPCError> {
        await protocolServer.server.dispatch(request)
    }

    /// The server AemiMCP's stdio runner serves.
    var protocolHandler: MCPServer { protocolServer.server }

    private func makeProtocolServer() -> MCPServer {
        MCPServer(
            configuration: MCPServerConfiguration(
                name: "apple-docs",
                version: AppleDocsVersion.current,
                protocolVersions: Self.protocolVersions,
                supportsResources: true
            ),
            tools: MCPToolDescriptor.allTools.map(\.tool),
            callTool: { [weak self] name, arguments in
                try await Self.alive(self).toolResult(name: name, arguments: arguments.json)
            },
            listResources: { [weak self] in try await Self.alive(self).resources() },
            listResourceTemplates: { Self.resourceTemplates },
            readResource: { [weak self] uri in try await Self.alive(self).readResource(uri) }
        )
    }

    /// The dispatcher a handler serves, which owns the server and so outlives every request it handles.
    private static func alive(_ dispatcher: MCPServerDispatcher?) throws(JSONRPCError) -> MCPServerDispatcher {
        guard let dispatcher else {
            throw JSONRPCError(code: JSONRPCError.internalError, message: "The server is shutting down.")
        }
        return dispatcher
    }
}

/// Holds the dispatcher's protocol server, which is made after the dispatcher's other members because its handlers call
/// the dispatcher.
private final class ProtocolServerSlot: Sendable {
    private let slot = Mutex<MCPServer?>(nil)

    func install(_ server: MCPServer) {
        slot.withLock { $0 = server }
    }

    var server: MCPServer {
        // `install` runs at the end of the dispatcher's init, before any caller can reach it.
        slot.withLock { $0 } ?? MCPServer(configuration: MCPServerConfiguration(name: "apple-docs", version: "0"))
    }
}
