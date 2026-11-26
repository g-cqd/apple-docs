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
        let minVersion = args["minVersion"]
        var minimums: [String: String] = [:]
        for key in ["ios", "macos", "watchos", "tvos", "visionos"] {
            if let value = minVersion[key].string { minimums[key] = value }
        }
        let options = SearchOptions(
            query: args["query"].string ?? "",
            framework: args["framework"].string,
            source: args["source"].string,
            kind: args["kind"].string,
            language: args["language"].string,
            platform: args["platform"].string,
            minimumVersions: minimums,
            limit: args["limit"].int ?? 25,
            year: args["year"].int,
            track: args["track"].string,
            deprecated: args["deprecated"].string
        )
        let semantic = await reader.semanticResources()
        let outcome = try await reader.withConnection { try CorpusSearch.search(options, semantic: semantic, on: $0) }
        if args["read"].bool == true, let top = outcome.results.first {
            return try await readTopHit(top.jsonValue, path: top.path, args: args, maxChars: maxChars)
        }
        let result = outcome.jsonValue
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

    private func readTopHit(_ top: JSONValue, path: String, args: JSON, maxChars: Int?) async throws -> JSONValue {
        let match = MatchOptions(args["match"])
        let request = DocumentLookup.Request(path: path, includeSections: maxChars != nil || match != nil)
        let page = try await reader.withStore { try DocumentLookup.lookup(request, on: $0) }
        var read: OrderedDictionary<String, JSONValue> = [
            "found": MCPPayloadProjection.member(page, "found") ?? .bool(false),
            "bestMatch": top,
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
