import AemiHTTP
import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsSearch
import Foundation

/// Server-rendered HTML pages.
extension WebHTTPResponder {
    func handlePage(_ target: WebRequestTarget) async -> ServerResponse {
        let path = target.path
        do {
            switch path {
                case "/", "/index.html":
                    let roots = try await reader.withStore { try CorpusQueryService.listFrameworks(on: $0) }
                    return htmlResponse(WebHTMLRenderer.renderIndexPage(frameworks: roots))
                case "/search":
                    return try await searchPage(query: target.query)
                case "/symbols":
                    let query = target.query["q"] ?? ""
                    let scope = target.query["scope"] == "private" ? "private" : "public"
                    let symbols = try await reader.withConnection { connection in
                        try AssetQueryService.searchSFSymbols(query: query, scope: scope, limit: 300, on: connection)
                    }
                    return htmlResponse(WebHTMLRenderer.renderSymbolsPage(query: query, scope: scope, symbols: symbols))
                case "/fonts":
                    let families = try await reader.withConnection { try AssetQueryService.listAppleFonts(on: $0) }
                    return htmlResponse(WebHTMLRenderer.renderFontsPage(families: families))
                default:
                    guard path.hasPrefix("/doc/") else { return notFoundPage(path) }
                    return try await documentPage(path: path)
            }
        } catch {
            return htmlResponse(WebHTMLRenderer.renderNotFoundPage(path: path), status: .internalServerError)
        }
    }

    private func searchPage(query: [String: String]) async throws -> ServerResponse {
        let text = (query["q"] ?? "").trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return htmlResponse(WebHTMLRenderer.renderSearchPage(query: "", results: [])) }
        let request = CorpusSearchRequest(
            query: text,
            framework: query["framework"],
            kind: query["kind"],
            language: query["language"],
            limit: 50
        )
        let results = try await reader.withConnection { try CorpusQueryService.search(request, on: $0) }
        return htmlResponse(WebHTMLRenderer.renderSearchPage(query: text, results: results))
    }

    private func documentPage(path: String) async throws -> ServerResponse {
        var rawKey = Substring(path.dropFirst("/doc/".count))
        while rawKey.hasSuffix("/") { rawKey = rawKey.dropLast() }
        if rawKey.hasSuffix("/index.html") { rawKey = rawKey.dropLast("/index.html".count) }
        guard let key = try? DocumentKey(String(rawKey)) else {
            return htmlResponse(WebHTMLRenderer.renderNotFoundPage(path: path), status: .badRequest)
        }
        guard let view = try await reader.withStore({ try WebDocumentView.load(key: key, store: $0) }) else {
            return notFoundPage(path)
        }
        return htmlResponse(WebHTMLRenderer.renderDocumentPage(view))
    }
}
