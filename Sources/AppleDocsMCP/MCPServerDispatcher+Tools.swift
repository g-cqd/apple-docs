import AemiJSONCore
import AemiJSONRPC
import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsSearch
import AppleDocsStorage
import OrderedCollections

extension MCPServerDispatcher {
    func handleToolCall(_ params: JSON?) async -> Result<JSONValue, JSONRPCError> {
        guard let params, params.isObject, let name = params["name"].string else {
            return .failure(JSONRPCError(code: JSONRPCError.invalidParams, message: "Missing tool name."))
        }
        do {
            let payload = try await invokeTool(name: name, arguments: params["arguments"])
            // Bun `createMcpTextResult`: the projected payload as compact JSON text plus `structuredContent`.
            return .success(
                .object([
                    "content": .array([
                        .object(["type": .string("text"), "text": .string(JavaScriptJSON.stringify(payload))])
                    ]),
                    "structuredContent": payload
                ])
            )
        } catch let rpcError as JSONRPCError where rpcError.code == JSONRPCError.methodNotFound {
            return .failure(rpcError)
        } catch {
            // Tool failures are results with `isError` (MCP SDK behaviour Bun relies on), not protocol errors.
            return .success(Self.toolError(Self.message(for: error)))
        }
    }

    static func toolError(_ message: String) -> JSONValue {
        .object([
            "content": .array([.object(["type": .string("text"), "text": .string(message)])]),
            "isError": .bool(true)
        ])
    }

    private static func message(for error: any Error) -> String {
        switch error {
            case let error as ToolPayloadError: error.message
            case let error as MCPPaginationError: error.message
            case let error as JSONRPCError: error.message
            default: "Tool execution failed."
        }
    }

    private func invokeTool(name: String, arguments: JSON) async throws -> JSONValue {
        switch name {
            case "search_docs": return try await invokeSearchDocs(arguments)
            case "read_doc": return try await invokeReadDoc(arguments)
            case "list_frameworks":
                let kind = arguments["kind"].string
                let result = try await reader.withConnection { try ToolPayloads.frameworks(kind: kind, on: $0) }
                return MCPPayloadProjection.frameworks(
                    try paginated(result, field: "roots", arguments: arguments)
                )
            case "browse": return try await invokeBrowse(arguments)
            case "list_taxonomy":
                let field = arguments["field"].string
                let all = arguments["all"].bool == true
                return MCPPayloadProjection.taxonomy(
                    try await reader.withConnection { try ToolPayloads.taxonomy(field: field, all: all, on: $0) }
                )
            case "search_sf_symbols":
                let (query, scope, limit) = (
                    arguments["query"].string, arguments["scope"].string, arguments["limit"].int
                )
                return MCPPayloadProjection.sfSymbols(
                    try await reader.withConnection {
                        try ToolPayloads.sfSymbols(query: query, scope: scope, limit: limit, on: $0)
                    }
                )
            case "list_apple_fonts":
                return MCPPayloadProjection.appleFonts(
                    try await reader.withConnection { try ToolPayloads.appleFonts(on: $0) }
                )
            case "render_sf_symbol": return try Self.parsed(try await invokeRenderSFSymbol(arguments))
            case "render_font_text": return try Self.parsed(try await invokeRenderFontText(arguments))
            default:
                throw JSONRPCError(code: JSONRPCError.methodNotFound, message: "Unknown tool: \(name)")
        }
    }

    private static func parsed(_ text: String) throws -> JSONValue {
        JSONValue(try AemiJSON.parse(Array(text.utf8)).root)
    }

    private func invokeBrowse(_ args: JSON) async throws -> JSONValue {
        let request = ToolPayloads.BrowseRequest(
            framework: args["framework"].string,
            path: args["path"].string,
            year: args["year"].int,
            limit: args["limit"].int
        )
        let result = try await reader.withConnection { try ToolPayloads.browse(request, on: $0) }
        return MCPPayloadProjection.browse(
            try paginated(result, field: args["path"].string == nil ? "pages" : "children", arguments: args)
        )
    }

    /// `validatePaginationArgs` + `paginateArrayField` when `maxChars` is present.
    func paginated(_ payload: JSONValue, field: String, arguments: JSON) throws -> JSONValue {
        guard let maxChars = try Self.paginationArguments(arguments) else { return payload }
        return try MCPPagination.paginateArrayField(
            payload,
            field: field,
            maxChars: maxChars,
            page: arguments["page"].int ?? 1
        )
    }

    /// Validates `maxChars`/`page` like Bun's zod schema and `validatePaginationArgs`; `nil` when unpaginated.
    static func paginationArguments(_ arguments: JSON) throws -> Int? {
        let maxChars = arguments["maxChars"].int
        if arguments["page"].exists, !arguments["page"].isNull {
            guard let page = arguments["page"].int, (1 ... 10_000).contains(page) else {
                throw ToolPayloadError("Invalid arguments: page must be an integer between 1 and 10000.")
            }
            if maxChars == nil { throw ToolPayloadError("The page parameter requires maxChars.") }
        }
        guard let maxChars else { return nil }
        guard (MCPPagination.minMaxChars ... 100_000).contains(maxChars) else {
            throw ToolPayloadError("Invalid arguments: maxChars must be an integer between 512 and 100000.")
        }
        return maxChars
    }

    func requiredString(_ args: JSON, key: String, tool: String) throws(JSONRPCError) -> String {
        guard let value = args[key].string, !value.isEmpty else {
            throw JSONRPCError(code: JSONRPCError.invalidParams, message: "\(tool) requires '\(key)'.")
        }
        return value
    }
}
