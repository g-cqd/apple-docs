public import AemiHTTP
public import AppleDocsCommands
import AppleDocsCore

/// Cross-platform HTTP responder powering `apple-docs web serve` on `g-cqd/HTTP`.
///
/// Serves:
/// - Discovery & health: `/healthz`, `/readyz`, `/robots.txt`, `/.well-known/api-catalog`,
///   `/.well-known/mcp/server-card.json`, `/.well-known/security.txt`
/// - Read-only JSON API (all routed through `AppleDocsOutput`): `/api/search`, `/api/doc`,
///   `/api/frameworks`, `/api/symbols`, `/api/fonts`
/// - Escaped SSR HTML pages: `/`, `/search`, `/doc/<key>`, `/symbols`, `/fonts`, styled 404
/// - Resources: `/assets/*`, `/symbols/<scope>/<name>.svg`, `/sitemap.xml`, `/sitemaps/<slug>.xml`
/// - Strict security response headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy`, CSP).
public struct WebHTTPResponder: HTTPResponder, Sendable {
    let reader: CorpusReaderHandle
    let site: WebSiteConfiguration

    public init(reader: CorpusReaderHandle, site: WebSiteConfiguration = WebSiteConfiguration()) {
        self.reader = reader
        self.site = site
    }

    public init(
        databasePath: String,
        resourcesDirectory: String? = nil,
        site: WebSiteConfiguration = WebSiteConfiguration(),
        maxReaders: Int = 4
    ) {
        self.init(
            reader: CorpusReaderHandle(
                databasePath: databasePath,
                resourcesDirectory: resourcesDirectory,
                maxReaders: maxReaders
            ),
            site: site
        )
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
            return hardened(.status(.methodNotAllowed), cacheControl: "no-store")
        }
        let requested = WebRequestTarget(request.path)
        guard let sitePath = site.sitePath(forRequestPath: requested.path) else {
            return hardened(notFoundPage(requested.path), cacheControl: "no-store")
        }
        let target = WebRequestTarget(path: sitePath, query: requested.query)
        let response: ServerResponse =
            if let discovery = handleDiscovery(path: target.path) {
                discovery
            } else if target.path.hasPrefix("/api/") {
                await handleAPI(path: target.path, query: target.query)
            } else if let resource = await handleResource(path: target.path) {
                resource
            } else {
                await handlePage(target)
            }
        return hardened(response, cacheControl: Self.cachePolicy(path: target.path, status: response.head.status))
    }

    /// `Cache-Control` for a response the responder did not mark itself: long-lived assets, short-lived
    /// pages/API, nothing for errors and health probes.
    static func cachePolicy(path: String, status: HTTPStatus) -> String {
        guard status == .ok, path != "/healthz", path != "/readyz" else { return "no-store" }
        if path.hasPrefix("/assets/") || (path.hasPrefix("/symbols/") && path.hasSuffix(".svg")) {
            return "public, max-age=86400"
        }
        return path.hasPrefix("/api/") ? "public, max-age=60" : "public, max-age=300"
    }

    private func handleDiscovery(path: String) -> ServerResponse? {
        switch path {
            case "/healthz", "/readyz":
                return .json(Array("{\"status\":\"ok\",\"version\":\"\(AppleDocsVersion.current)\"}".utf8), status: .ok)
            case "/robots.txt":
                return .text("User-agent: *\nAllow: /\nSitemap: \(site.baseURL)/sitemap.xml\n", status: .ok)
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

    /// A response with `body` and `contentType`; extra headers (e.g. a stricter CSP) are kept by ``hardened(_:)``.
    func response(
        _ body: [UInt8],
        contentType: String,
        status: HTTPStatus = .ok,
        extraHeaders: [(HTTPFieldName, String)] = []
    ) -> ServerResponse {
        var headers = HTTPFields()
        _ = headers.setValue(contentType, for: .contentType)
        for (name, value) in extraHeaders { _ = headers.setValue(value, for: name) }
        return ServerResponse(HTTPResponse(status: status, headerFields: headers), body: body)
    }

    func htmlResponse(_ html: String, status: HTTPStatus = .ok) -> ServerResponse {
        response(Array(site.rooted(html).utf8), contentType: "text/html; charset=utf-8", status: status)
    }

    func notFoundPage(_ path: String) -> ServerResponse {
        htmlResponse(WebHTMLRenderer.renderNotFoundPage(path: path), status: .notFound)
    }

    private func hardened(_ response: ServerResponse, cacheControl: String) -> ServerResponse {
        var headers = response.head.headerFields
        if headers[.cacheControl] == nil { _ = headers.setValue(cacheControl, for: .cacheControl) }
        _ = headers.setValue("nosniff", for: .xContentTypeOptions)
        _ = headers.setValue("no-referrer", for: .referrerPolicy)
        if headers[.contentSecurityPolicy] == nil {
            _ = headers.setValue(
                "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
                for: .contentSecurityPolicy
            )
        }
        return ServerResponse(HTTPResponse(status: response.head.status, headerFields: headers), body: response.body)
    }
}
