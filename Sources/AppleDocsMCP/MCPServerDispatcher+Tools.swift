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
        let arguments = params["arguments"]
        do {
            let text = try await invokeTool(name: name, arguments: arguments)
            return .success(
                .object([
                    "content": .array([
                        .object(["type": .string("text"), "text": .string(text)])
                    ])
                ])
            )
        } catch let rpcError as JSONRPCError {
            return .failure(rpcError)
        } catch {
            return .failure(JSONRPCError(code: JSONRPCError.internalError, message: "Tool execution failed."))
        }
    }

    private func invokeTool(name: String, arguments: JSON) async throws -> String {
        switch name {
            case "search_docs":
                return try await invokeSearchDocs(arguments)
            case "read_doc":
                return try await invokeReadDoc(arguments)
            case "list_frameworks":
                return try await invokeListFrameworks(arguments)
            case "browse":
                return try await invokeBrowse(arguments)
            case "list_taxonomy":
                return try await invokeListTaxonomy(arguments)
            case "search_sf_symbols":
                return try await invokeSearchSFSymbols(arguments)
            case "list_apple_fonts":
                return try await invokeListAppleFonts()
            default:
                throw JSONRPCError(code: JSONRPCError.methodNotFound, message: "Unknown tool: \(name)")
        }
    }

    private func invokeSearchDocs(_ args: JSON) async throws -> String {
        let query = try requiredString(args, key: "query", tool: "search_docs")
        let deprecated =
            args["deprecated"].string
            .flatMap(CorpusSearchRequest.DeprecatedFilter.init(rawValue:)) ?? .include
        let request = CorpusSearchRequest(
            query: query,
            framework: args["framework"].string,
            kind: args["kind"].string,
            language: args["language"].string,
            deprecated: deprecated,
            limit: args["limit"].int ?? 25
        )
        return try await encodeFromPool { conn in
            try CorpusQueryService.search(request, on: conn)
        }
    }

    private func invokeReadDoc(_ args: JSON) async throws -> String {
        let pathArg = args["path"].string
        let symbolArg = args["symbol"].string
        let frameworkArg = args["framework"].string
        let maxChars = args["maxChars"].int
        let page = args["page"].int ?? 1
        let dbPath = databasePath

        let detail: PublicDocumentDetail? =
            try await Task.detached {
                let store = try CorpusStore(path: dbPath, options: .readOnly)
                defer { store.close() }
                if let pathArg {
                    let key = try DocumentKey(pathArg)
                    return try CorpusQueryService.readDocument(key: key, on: store)
                }
                if let symbolArg {
                    return try CorpusQueryService.readSymbol(named: symbolArg, framework: frameworkArg, on: store)
                }
                throw JSONRPCError(code: JSONRPCError.invalidParams, message: "read_doc requires 'path' or 'symbol'.")
            }
            .value

        guard let detail else {
            throw JSONRPCError(code: JSONRPCError.invalidParams, message: "Document not found.")
        }
        let markdown = detail.renderMarkdown()
        if let maxChars {
            let slice = PublicProjection.paginate(markdown, maxChars: maxChars, page: page)
            return "\(slice.text)\n\n<!-- page \(slice.page)/\(slice.totalPages) -->"
        }
        return markdown
    }

    private func invokeListFrameworks(_ args: JSON) async throws -> String {
        let kind = args["kind"].string
        let dbPath = databasePath
        let items =
            try await Task.detached {
                let store = try CorpusStore(path: dbPath, options: .readOnly)
                defer { store.close() }
                return try CorpusQueryService.listFrameworks(kind: kind, on: store)
            }
            .value
        return try PublicProjection.encodeJSON(items)
    }

    private func invokeBrowse(_ args: JSON) async throws -> String {
        let framework = try requiredString(args, key: "framework", tool: "browse")
        let pathPrefix = args["path"].string
        let limit = args["limit"].int ?? 100
        return try await encodeFromPool { conn in
            try CorpusQueryService.browse(framework: framework, pathPrefix: pathPrefix, limit: limit, on: conn)
        }
    }

    private func invokeListTaxonomy(_ args: JSON) async throws -> String {
        let fieldName = args["field"].string ?? "kind"
        guard let field = CorpusQueryService.TaxonomyField(rawValue: fieldName) else {
            throw JSONRPCError(code: JSONRPCError.invalidParams, message: "Unsupported taxonomy field: \(fieldName)")
        }
        let limit = (args["all"].bool == true) ? 500 : 20
        return try await encodeFromPool { conn in
            try CorpusQueryService.listTaxonomy(field: field, limit: limit, on: conn)
        }
    }

    private func invokeSearchSFSymbols(_ args: JSON) async throws -> String {
        let query = args["query"].string ?? ""
        let scope = args["scope"].string ?? "public"
        let limit = args["limit"].int ?? 100
        return try await encodeFromPool { conn in
            try AssetQueryService.searchSFSymbols(query: query, scope: scope, limit: limit, on: conn)
        }
    }

    private func invokeListAppleFonts() async throws -> String {
        try await encodeFromPool { conn in
            try AssetQueryService.listAppleFonts(on: conn)
        }
    }

    private func requiredString(_ args: JSON, key: String, tool: String) throws(JSONRPCError) -> String {
        guard let value = args[key].string, !value.isEmpty else {
            throw JSONRPCError(code: JSONRPCError.invalidParams, message: "\(tool) requires '\(key)'.")
        }
        return value
    }

    private func encodeFromPool<T: Encodable & Sendable>(
        _ query: @escaping @Sendable (SQLiteConnection) throws -> T
    ) async throws -> String {
        let value = try await pool.withConnection(query)
        return try PublicProjection.encodeJSON(value)
    }
}
