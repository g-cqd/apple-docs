// The Model Context Protocol core. In-house JSON-RPC 2.0 over a
// newline-delimited stdio transport — no `@modelcontextprotocol/sdk`. The dispatcher
// handles initialize / ping / tools/list / tools/call (+ notifications/initialized);
// the tool surface is provided by the DSL (`MCPToolProviding`). Everything is built on
// ADJSON `JSONValue` so the wire shapes stay intrinsic-identical to the SDK's output.

public import ADJSON
public import ADStorage
import Foundation
public import Logging

// MARK: - JSONValue helpers (minimal, ADJSON-agnostic)

public func jsonObject(_ value: JSONValue?) -> OrderedDictionary<String, JSONValue>? {
    if case .object(let object)? = value { return object }
    return nil
}
public func jsonString(_ value: JSONValue?) -> String? {
    if case .string(let string)? = value { return string }
    return nil
}
public func jsonArray(_ value: JSONValue?) -> [JSONValue]? {
    if case .array(let array)? = value { return array }
    return nil
}
public func jsonNumber(_ value: JSONValue?) -> Double? {
    if case .number(let number)? = value { return number }
    return nil
}
public func jsonBool(_ value: JSONValue?) -> Bool? {
    if case .bool(let bool)? = value { return bool }
    return nil
}
/// A JSON number read as an Int (the MCP args send integers as JSON numbers).
/// NaN/infinite → nil; out-of-range magnitudes clamp to `Int.min`/`Int.max`
/// instead of trapping on the `Int(Double)` conversion.
public func jsonInt(_ value: JSONValue?) -> Int? {
    guard let number = jsonNumber(value), number.isFinite else { return nil }
    if number >= Double(Int.max) { return Int.max }
    if number <= Double(Int.min) { return Int.min }
    return Int(number)
}
/// `object[key]` for a `.object` value.
public func jsonMember(_ value: JSONValue?, _ key: String) -> JSONValue? { jsonObject(value)?[key] }

// MARK: - Server identity + tool contract

/// The MCP `serverInfo` + `instructions` (app-provided, like SiteConfig).
public struct MCPServerInfo: Sendable {
    public let name: String
    public let version: String
    public let instructions: String?
    public init(name: String, version: String, instructions: String?) {
        self.name = name
        self.version = version
        self.instructions = instructions
    }
}

/// A tool's `tools/list` entry. `inputSchema`/`annotations` are pre-built JSONValues
/// (the DSL's `Schema` helpers build them — the zod replacement).
public struct MCPToolDefinition: Sendable {
    public let name: String
    public let description: String
    public let inputSchema: JSONValue
    public let annotations: JSONValue
    public init(name: String, description: String, inputSchema: JSONValue, annotations: JSONValue) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
        self.annotations = annotations
    }
}

/// The per-call context handed to a tool. stdio is a single serial client, so one
/// connection suffices (no pool).
public struct MCPToolContext: Sendable {
    public let connection: StorageConnection
    public let logger: Logger
    public init(connection: StorageConnection, logger: Logger) {
        self.connection = connection
        self.logger = logger
    }
}

/// A tool's outcome: pre-serialized payload bytes, a `JSONValue` payload, or an error
/// message. `.ok`/`.okValue` both project to `{content,structuredContent}`; `.failure`
/// to `{content,isError:true}`. `.okValue` lets JSON-producing tools hand the value
/// straight through — the dispatcher encodes it once for `text` and reuses it as
/// `structuredContent` (no encode→parse→re-encode round trip). `.ok` stays for tools
/// that already emit raw bytes (the search cascade), where one parse is unavoidable.
public enum MCPToolResult: Sendable {
    case ok([UInt8])
    case okValue(JSONValue)
    case failure(String)
}

/// The tool surface the dispatcher resolves against (the DSL's `ToolRegistry` conforms).
public protocol MCPToolProviding: Sendable {
    var toolDefinitions: [MCPToolDefinition] { get }
    func invoke(name: String, arguments: JSONValue, context: MCPToolContext) -> MCPToolResult
}

// MARK: - Dispatcher

/// Handles one JSON-RPC line; returns the response bytes (with the trailing newline) or
/// nil for notifications / non-requests.
public struct MCPDispatcher: Sendable {
    let serverInfo: MCPServerInfo
    let tools: any MCPToolProviding

    public init(serverInfo: MCPServerInfo, tools: any MCPToolProviding) {
        self.serverInfo = serverInfo
        self.tools = tools
    }

    /// The protocol versions the SDK supports (newest first); we echo the client's if it
    /// is one of these, else fall back to the latest.
    private static let supportedVersions = [
        "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"
    ]

    public func handle(line: String, context: MCPToolContext) -> [UInt8]? {
        let trimmed = line.hasSuffix("\r") ? String(line.dropLast()) : line
        if trimmed.isEmpty { return nil }
        guard let request = try? JSONValue(parsing: trimmed), let object = jsonObject(request) else {
            return encodeLine(rpcError(.null, code: -32700, message: "Parse error"))
        }
        let id = object["id"]
        guard let method = jsonString(object["method"]) else { return nil }
        let params = object["params"] ?? .object([:])

        switch method {
            case "initialize":
                return respond(id, initializeResult(params))
            case "notifications/initialized":
                return nil
            case "ping":
                return respond(id, .object([:]))
            case "tools/list":
                return respond(id, toolsListResult())
            case "tools/call":
                return respond(id, toolsCallResult(params, context: context))
            default:
                guard let id else { return nil }
                return encodeLine(rpcError(id, code: -32601, message: "Method not found"))
        }
    }

    // MARK: result builders

    private func initializeResult(_ params: JSONValue) -> JSONValue {
        let requested = jsonString(jsonMember(params, "protocolVersion"))
        let version = (requested.map(Self.supportedVersions.contains) == true) ? requested! : "2025-11-25"
        var result: OrderedDictionary<String, JSONValue> = [
            "protocolVersion": .string(version),
            "capabilities": .object([
                "resources": .object(["listChanged": .bool(true)]),
                "tools": .object(["listChanged": .bool(true)])
            ]),
            "serverInfo": .object([
                "name": .string(serverInfo.name), "version": .string(serverInfo.version)
            ])
        ]
        if let instructions = serverInfo.instructions { result["instructions"] = .string(instructions) }
        return .object(result)
    }

    private func toolsListResult() -> JSONValue {
        .object([
            "tools": .array(
                tools.toolDefinitions.map { definition in
                    .object([
                        "name": .string(definition.name),
                        "description": .string(definition.description),
                        "inputSchema": definition.inputSchema,
                        "annotations": definition.annotations,
                        "execution": .object(["taskSupport": .string("forbidden")])
                    ])
                })
        ])
    }

    private func toolsCallResult(_ params: JSONValue, context: MCPToolContext) -> JSONValue {
        guard let name = jsonString(jsonMember(params, "name")) else {
            return errorContent("Missing tool name")
        }
        let arguments = jsonMember(params, "arguments") ?? .object([:])
        switch tools.invoke(name: name, arguments: arguments, context: context) {
            case .ok(let bytes):
                let text = String(decoding: bytes, as: UTF8.self)
                let structured = (try? JSONValue(parsing: text)) ?? .null
                return .object([
                    "content": .array([textContent(text)]), "structuredContent": structured
                ])
            case .okValue(let value):
                let bytes = (try? value.encoded()).map(Array.init) ?? Array("null".utf8)
                return .object([
                    "content": .array([textContent(String(decoding: bytes, as: UTF8.self))]),
                    "structuredContent": value
                ])
            case .failure(let message):
                return errorContent(message)
        }
    }

    private func textContent(_ text: String) -> JSONValue {
        .object(["type": .string("text"), "text": .string(text)])
    }

    private func errorContent(_ message: String) -> JSONValue {
        .object(["content": .array([textContent(message)]), "isError": .bool(true)])
    }

    private func respond(_ id: JSONValue?, _ result: JSONValue) -> [UInt8]? {
        guard let id else { return nil }
        return encodeLine(rpcResult(id, result))
    }

    private func rpcResult(_ id: JSONValue, _ result: JSONValue) -> JSONValue {
        .object(["jsonrpc": .string("2.0"), "id": id, "result": result])
    }

    private func rpcError(_ id: JSONValue, code: Int, message: String) -> JSONValue {
        .object([
            "jsonrpc": .string("2.0"), "id": id,
            "error": .object(["code": .number(Double(code)), "message": .string(message)])
        ])
    }

    private func encodeLine(_ value: JSONValue) -> [UInt8] {
        var bytes = (try? value.encoded()).map { Array($0) } ?? Array("null".utf8)
        bytes.append(0x0A)
        return bytes
    }
}

// MARK: - stdio transport

/// Reads newline-delimited JSON-RPC from stdin and writes responses to stdout. One
/// serial client; synchronous read loop (the process exists to serve stdin).
public struct StdioMCPTransport: Sendable {
    let dispatcher: MCPDispatcher
    let context: MCPToolContext
    public init(dispatcher: MCPDispatcher, context: MCPToolContext) {
        self.dispatcher = dispatcher
        self.context = context
    }

    public func run() {
        let out = FileHandle.standardOutput
        while let line = readLine(strippingNewline: true) {
            if let response = dispatcher.handle(line: line, context: context) {
                out.write(Data(response))
            }
        }
    }
}
