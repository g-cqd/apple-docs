import AemiJSONCore
import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsSearch
import OrderedCollections

/// `read_doc` and `search_docs`, ported from Bun's `mcp/tools/docs.js`.
extension MCPServerDispatcher {
    func invokeReadDoc(_ args: JSON) async throws -> JSONValue {
        let maxChars = try Self.paginationArguments(args)
        let match = MatchOptions(args["match"])
        // @dl:accept -- tool argument mapping
        let request = DocumentLookup.Request(
            path: args["path"].string,
            symbol: args["symbol"].string,
            framework: args["framework"].string,
            section: args["section"].string,
            includeSections: maxChars != nil || match != nil
        )
        var payload = try await reader.withStore { try DocumentLookup.lookup(request, on: $0) }
        if let match { payload = match.apply(to: payload) }
        if let maxChars {
            payload = try MCPPagination.paginateDocument(payload, maxChars: maxChars, page: args["page"].int ?? 1)
        }
        let full = request.section != nil || match != nil || maxChars != nil
        return MCPPayloadProjection.readDoc(payload, full: full)
    }

    func invokeSearchDocs(_ args: JSON) async throws -> JSONValue {
        let maxChars = try Self.paginationArguments(args)
        let query = args["query"].string ?? ""
        let minVer = args["minVersion"]
        let request = CorpusSearchRequest(
            query: query,
            framework: args["framework"].string,
            kind: args["kind"].string,
            language: args["language"].string,
            sources: CorpusQueryService.parseSourceKinds(args["source"].string),
            deprecated: args["deprecated"].string.flatMap(CorpusSearchRequest.DeprecatedFilter.init(rawValue:))
                ?? .include,
            minVersions: PlatformAvailability(
                ios: minVer["ios"].string,
                macos: minVer["macos"].string,
                watchos: minVer["watchos"].string,
                tvos: minVer["tvos"].string,
                visionos: minVer["visionos"].string
            ),
            limit: args["limit"].int ?? 25
        )
        let semantic = await reader.semanticResources()
        let hits = try await reader.withConnection { connection in
            try CorpusQueryService.search(request, semantic: semantic, on: connection)
        }
        if args["read"].bool == true, let top = hits.first {
            return try await readTopHit(top, args: args, maxChars: maxChars)
        }
        let result: JSONValue = .object([
            "results": .array(hits.map(Self.searchHit)), "total": .int(Int64(hits.count)),
            "query": .string(query), "hasMore": .bool(false)
        ])
        let payload =
            maxChars == nil
            ? result
            : try MCPPagination.paginateArrayField(
                result,
                field: "results",
                maxChars: maxChars ?? 0,
                page: args["page"].int ?? 1
            )
        return MCPPayloadProjection.searchResult(payload)
    }

    private func readTopHit(_ top: PublicSearchResult, args: JSON, maxChars: Int?) async throws -> JSONValue {
        let match = MatchOptions(args["match"])
        let request = DocumentLookup.Request(path: top.path, includeSections: maxChars != nil || match != nil)
        let page = try await reader.withStore { try DocumentLookup.lookup(request, on: $0) }
        var read: OrderedDictionary<String, JSONValue> = [
            "found": MCPPayloadProjection.member(page, "found") ?? .bool(false),
            "bestMatch": Self.searchHit(top),
            "metadata": MCPPayloadProjection.member(page, "metadata") ?? .null
        ]
        let note = MCPPayloadProjection.member(page, "note")
        let content = MCPPayloadProjection.member(page, "content")
        read["content"] = content.flatMap { $0 == .null ? nil : $0 } ?? note ?? .string("Markdown not available.")
        read["sections"] = MCPPayloadProjection.member(page, "sections") ?? .array([])
        if let note, note != .null { read["note"] = note }
        var payload: JSONValue = .object(read)
        if let match { payload = match.apply(to: payload) }
        if let maxChars {
            payload = try MCPPagination.paginateDocument(payload, maxChars: maxChars, page: args["page"].int ?? 1)
        }
        return MCPPayloadProjection.readDoc(payload, full: match != nil || maxChars != nil)
    }

    /// A search hit in Bun's rich shape (before ``MCPPayloadProjection/searchHit(_:)``).
    static func searchHit(_ result: PublicSearchResult) -> JSONValue {
        let document = result.document
        // @dl:accept -- Bun search-hit wire shape (field list, not shared logic)
        var hit: OrderedDictionary<String, JSONValue> = [
            "path": .string(document.path), "title": .string(document.title), "framework": .string(document.framework),
            "rootSlug": .string(document.framework), "kind": DocCValue.optional(document.roleHeading ?? document.kind),
            "sourceType": .string(document.sourceType.rawValue), "abstract": DocCValue.optional(document.abstract),
            "declaration": DocCValue.optional(document.declaration), "language": DocCValue.optional(document.language),
            "matchQuality": .string(result.confidence == "exact" ? "exact" : "match")
        ]
        if document.isDeprecated == true { hit["isDeprecated"] = .bool(true) }
        if document.isBeta == true { hit["isBeta"] = .bool(true) }
        return .object(hit)
    }
}

/// `match` tool argument (`{query, context, max, caseSensitive}`).
private struct MatchOptions {
    let query: String
    let context: Int
    let max: Int
    let caseSensitive: Bool

    init?(_ json: JSON) {
        guard json.isObject, let query = json["query"].string else { return nil }
        self.query = query
        self.context = json["context"].int ?? 140
        self.max = json["max"].int ?? 5
        self.caseSensitive = json["caseSensitive"].bool ?? false
    }

    func apply(to payload: JSONValue) -> JSONValue {
        MCPPagination.matched(
            payload,
            match: query,
            caseSensitive: caseSensitive,
            contextChars: context,
            maxMatches: max
        )
    }
}
