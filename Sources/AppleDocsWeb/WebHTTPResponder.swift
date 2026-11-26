public import AemiHTTP
public import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsSearch
import AppleDocsStorage
import Foundation

/// Cross-platform HTTP responder powering `apple-docs web serve` on `g-cqd/HTTP`.
///
/// Serves:
/// - Discovery & health: `/healthz`, `/readyz`, `/robots.txt`, `/.well-known/api-catalog`,
///   `/.well-known/mcp/server-card.json`, `/.well-known/security.txt`
/// - Read-only JSON API (all routed through `AppleDocsOutput`): `/api/search`, `/api/doc`,
///   `/api/frameworks`, `/api/symbols`, `/api/fonts`
/// - Escaped SSR HTML views: `/` and `/doc/<key>`
/// - Strict security response headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy`, CSP).
public struct WebHTTPResponder: HTTPResponder, Sendable {
    private let reader: CorpusReaderHandle

    public init(reader: CorpusReaderHandle) {
        self.reader = reader
    }

    public init(databasePath: String, maxReaders: Int = 4) {
        self.init(reader: CorpusReaderHandle(databasePath: databasePath, maxReaders: maxReaders))
    }

    public func close() async {
        await reader.close()
    }

    public func respond(
        to request: HTTPRequest,
        body: RequestBody,
        context: RequestContext
    ) async -> ServerResponse {
        guard request.method == .get || request.method == .head else {
            return hardened(.status(.methodNotAllowed))
        }
        let (path, query) = splitTarget(request.path)
        let response: ServerResponse =
            if let discovery = handleDiscovery(path: path) {
                discovery
            } else if path.hasPrefix("/api/") {
                await handleAPI(path: path, query: query)
            } else {
                await handleHTML(path: path)
            }
        return hardened(response)
    }

    private func handleDiscovery(path: String) -> ServerResponse? {
        switch path {
            case "/healthz", "/readyz":
                return .json(Array("{\"status\":\"ok\",\"version\":\"\(AppleDocsVersion.current)\"}".utf8), status: .ok)
            case "/robots.txt":
                return .text("User-agent: *\nAllow: /\n", status: .ok)
            case "/.well-known/security.txt":
                return .text("Contact: https://github.com/g-cqd/apple-docs/security/advisories\n", status: .ok)
            case "/.well-known/api-catalog":
                let catalog =
                    #"{"linkset":[{"anchor":"/api","service-desc":[{"href":"/api/frameworks","type":"application/json"}]}]}"#
                return .json(Array(catalog.utf8), status: .ok)
            case "/.well-known/mcp/server-card.json":
                let card =
                    #"{"name":"apple-docs","version":"\#(AppleDocsVersion.current)","transport":"streamable-http","endpoint":"/mcp"}"#
                return .json(Array(card.utf8), status: .ok)
            default:
                return nil
        }
    }

    private func handleAPI(path: String, query: [String: String]) async -> ServerResponse {
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

    private func handleHTML(path: String) async -> ServerResponse {
        do {
            if path == "/" || path == "/index.html" {
                let roots = try await reader.withStore { try CorpusQueryService.listFrameworks(kind: nil, on: $0) }
                return htmlResponse(WebHTMLRenderer.renderIndexPage(frameworks: roots), status: .ok)
            }
            if path.hasPrefix("/doc/") {
                let rawKey = String(path.dropFirst("/doc/".count))
                guard let key = try? DocumentKey(rawKey) else {
                    return .text("Invalid document key.", status: .badRequest)
                }
                guard let detail = try await reader.withStore({ try CorpusQueryService.readDocument(key: key, on: $0) })
                else {
                    return .text("Not found.", status: .notFound)
                }
                return htmlResponse(WebHTMLRenderer.renderDocumentPage(detail), status: .ok)
            }
            return .status(.notFound)
        } catch {
            return .text("Internal error.", status: .internalServerError)
        }
    }

    private func htmlResponse(_ html: String, status: HTTPStatus) -> ServerResponse {
        var headers = HTTPFields()
        _ = headers.setValue("text/html; charset=utf-8", for: .contentType)
        return ServerResponse(HTTPResponse(status: status, headerFields: headers), body: Array(html.utf8))
    }

    private func hardened(_ response: ServerResponse) -> ServerResponse {
        var headers = response.head.headerFields
        _ = headers.setValue("nosniff", for: .xContentTypeOptions)
        _ = headers.setValue("no-referrer", for: .referrerPolicy)
        _ = headers.setValue(
            "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
            for: .contentSecurityPolicy
        )
        return ServerResponse(
            HTTPResponse(status: response.head.status, headerFields: headers),
            body: response.body
        )
    }

    private func splitTarget(_ target: String) -> (String, [String: String]) {
        guard let qIndex = target.firstIndex(of: "?") else { return (target, [:]) }
        let path = String(target[..<qIndex])
        let queryString = String(target[target.index(after: qIndex)...])
        var params: [String: String] = [:]
        for pair in queryString.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            guard let rawKey = parts.first, !rawKey.isEmpty else { continue }
            let key = String(rawKey).removingPercentEncoding ?? String(rawKey)
            let rawValue = parts.count > 1 ? String(parts[1]) : ""
            let value = rawValue.replacing("+", with: " ").removingPercentEncoding ?? rawValue
            params[key] = value
        }
        return (path, params)
    }
}
