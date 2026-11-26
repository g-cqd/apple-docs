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
            case "render_sf_symbol":
                return try await invokeRenderSFSymbol(arguments)
            case "render_font_text":
                return try await invokeRenderFontText(arguments)
            default:
                throw JSONRPCError(code: JSONRPCError.methodNotFound, message: "Unknown tool: \(name)")
        }
    }

    private func invokeSearchDocs(_ args: JSON) async throws -> String {
        let query = try requiredString(args, key: "query", tool: "search_docs")
        let deprecated =
            args["deprecated"].string
            .flatMap(CorpusSearchRequest.DeprecatedFilter.init(rawValue:)) ?? .include
        let minVer = args["minVersion"]
        let availability = PlatformAvailability(
            ios: minVer["ios"].string,
            macos: minVer["macos"].string,
            watchos: minVer["watchos"].string,
            tvos: minVer["tvos"].string,
            visionos: minVer["visionos"].string
        )
        let request = CorpusSearchRequest(
            query: query,
            framework: args["framework"].string,
            kind: args["kind"].string,
            language: args["language"].string,
            sources: CorpusQueryService.parseSourceKinds(args["source"].string),
            deprecated: deprecated,
            minVersions: availability,
            limit: args["limit"].int ?? 25
        )
        let semantic = await reader.semanticResources()
        let results = try await reader.withConnection { conn in
            try CorpusQueryService.search(request, semantic: semantic, on: conn)
        }
        let encoded = try PublicProjection.encodeJSON(results)
        if args["read"].bool == true, let top = results.first, let key = try? DocumentKey(top.path) {
            if let detail = try await reader.withStore({ try CorpusQueryService.readDocument(key: key, on: $0) }) {
                let topText = try formatDocumentOutput(detail: detail, args: args)
                return "\(encoded)\n\n---\n\n\(topText)"
            }
        }
        return encoded
    }

    private func invokeReadDoc(_ args: JSON) async throws -> String {
        let pathArg = args["path"].string
        let symbolArg = args["symbol"].string
        let frameworkArg = args["framework"].string

        let detail: PublicDocumentDetail? = try await reader.withStore { store in
            if let pathArg {
                let key = try DocumentKey(pathArg)
                return try CorpusQueryService.readDocument(key: key, on: store)
            }
            if let symbolArg {
                return try CorpusQueryService.readSymbol(named: symbolArg, framework: frameworkArg, on: store)
            }
            throw JSONRPCError(code: JSONRPCError.invalidParams, message: "read_doc requires 'path' or 'symbol'.")
        }
        guard let detail else {
            throw JSONRPCError(code: JSONRPCError.invalidParams, message: "Document not found.")
        }
        return try formatDocumentOutput(detail: detail, args: args)
    }

    private func formatDocumentOutput(detail: PublicDocumentDetail, args: JSON) throws -> String {
        let matchObj = args["match"]
        if matchObj.isObject, let matchQuery = matchObj["query"].string, !matchQuery.isEmpty {
            let excerpts = detail.matchExcerpts(
                query: matchQuery,
                context: matchObj["context"].int ?? 140,
                maxMatches: matchObj["max"].int ?? 5,
                caseSensitive: matchObj["caseSensitive"].bool ?? false
            )
            return try PublicProjection.encodeJSON(excerpts)
        }
        let sectionHeading = args["section"].string
        guard let markdown = detail.renderMarkdown(sectionHeading: sectionHeading) else {
            throw JSONRPCError(
                code: JSONRPCError.invalidParams,
                message: "Section '\(sectionHeading ?? "")' not found."
            )
        }
        if let maxChars = args["maxChars"].int {
            let page = args["page"].int ?? 1
            let slice = PublicProjection.paginate(markdown, maxChars: maxChars, page: page)
            return "\(slice.text)\n\n<!-- page \(slice.page)/\(slice.totalPages) -->"
        }
        return markdown
    }

    private func invokeListFrameworks(_ args: JSON) async throws -> String {
        let kind = args["kind"].string
        let items = try await reader.withStore { store in
            try CorpusQueryService.listFrameworks(kind: kind, on: store)
        }
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

    private func invokeRenderSFSymbol(_ args: JSON) async throws -> String {
        let name = try requiredString(args, key: "name", tool: "render_sf_symbol")
        let options = SFSymbolRenderArgs(args: args)
        let resourcesDir = reader.resourcesDirectory
        return try await renderWithPermit {
            try AssetRenderService.renderSFSymbolSVG(
                name: name,
                scope: options.scope,
                size: options.size,
                color: options.color,
                background: options.background,
                resourcesDirectory: resourcesDir
            )
        }
    }

    private func invokeRenderFontText(_ args: JSON) async throws -> String {
        let fontID = try requiredString(args, key: "fontId", tool: "render_font_text")
        let text = args["text"].string ?? "AaBbCc 0123"
        let size = Double(args["size"].int ?? 48)
        let dbPath = reader.databasePath
        return try await renderWithPermit {
            let conn = try SQLiteConnection(path: dbPath, options: .readOnly)
            defer { conn.close() }
            return try await AssetRenderService.renderFontTextSVG(fontID: fontID, text: text, size: size, on: conn)
        }
    }

    private func renderWithPermit(_ work: @escaping @Sendable () async throws -> String) async throws -> String {
        try await renderPermits.withPermit(work)
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
        let value = try await reader.withConnection(query)
        return try PublicProjection.encodeJSON(value)
    }
}

private struct SFSymbolRenderArgs: Sendable {
    let scope: String
    let size: Int
    let color: String
    let background: String

    init(args: JSON) {
        self.scope = args["scope"].string ?? "public"
        self.size = args["size"].int ?? 128
        self.color = args["color"].string ?? "currentColor"
        self.background = args["background"].string ?? "transparent"
    }
}
