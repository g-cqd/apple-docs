import AemiHTTP
import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsSearch

/// Read-only JSON API (`/api/*`), every payload projected through `AppleDocsOutput`.
extension WebHTTPResponder {
    func handleAPI(path: String, query: [String: String]) async -> ServerResponse {
        do {
            switch path {
                case "/api/search":
                    guard let q = query["q"], !q.isEmpty else {
                        return .json(Array("{\"error\":\"missing q\"}".utf8), status: .badRequest)
                    }
                    let req = CorpusSearchRequest(
                        query: q,
                        framework: query["framework"],
                        kind: query["kind"],
                        language: query["language"],
                        limit: query["limit"].flatMap(Int.init) ?? 25
                    )
                    let hits = try await reader.withConnection { conn in
                        try CorpusQueryService.search(req, on: conn)
                    }
                    return .json(Array(try PublicProjection.encodeJSON(hits).utf8), status: .ok)

                case "/api/doc":
                    guard let rawPath = query["path"], let key = try? DocumentKey(rawPath) else {
                        return .json(Array("{\"error\":\"invalid path\"}".utf8), status: .badRequest)
                    }
                    guard
                        let detail = try await reader.withStore({
                            try CorpusQueryService.readDocument(key: key, on: $0)
                        })
                    else {
                        return .json(Array("{\"error\":\"not found\"}".utf8), status: .notFound)
                    }
                    return .json(Array(try PublicProjection.encodeJSON(detail).utf8), status: .ok)

                case "/api/frameworks":
                    let kind = query["kind"]
                    let items = try await reader.withStore { try CorpusQueryService.listFrameworks(kind: kind, on: $0) }
                    return .json(Array(try PublicProjection.encodeJSON(items).utf8), status: .ok)

                case "/api/symbols":
                    let q = query["q"] ?? ""
                    let scope = query["scope"] ?? "public"
                    let limit = query["limit"].flatMap(Int.init) ?? 100
                    let items = try await reader.withConnection { conn in
                        try AssetQueryService.searchSFSymbols(query: q, scope: scope, limit: limit, on: conn)
                    }
                    return .json(Array(try PublicProjection.encodeJSON(items).utf8), status: .ok)

                case "/api/fonts":
                    let items = try await reader.withConnection { conn in
                        try AssetQueryService.listAppleFonts(on: conn)
                    }
                    return .json(Array(try PublicProjection.encodeJSON(items).utf8), status: .ok)

                default:
                    return .status(.notFound)
            }
        } catch {
            return .json(Array("{\"error\":\"internal error\"}".utf8), status: .internalServerError)
        }
    }
}
