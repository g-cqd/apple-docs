import AppleDocsSources
import Synchronization

/// Test transport: routes by URL (404 when unrouted), honors `If-None-Match` against each route's ETag with a 304,
/// and records every request it served.
final class RecordingTransport: UpstreamHTTPTransport {
    struct Route {
        var body: String
        var etag: String?
        var status = 200
    }

    private let routes: Mutex<[String: Route]>
    private let log = Mutex<[UpstreamFetchRequest]>([])

    init(_ routes: [String: Route] = [:]) {
        self.routes = Mutex(routes)
    }

    func set(_ url: String, body: String, etag: String? = nil) {
        routes.withLock { $0[url] = Route(body: body, etag: etag) }
    }

    /// Answers `url` with a bare status code (e.g. 500 to make the client exhaust its retries and throw).
    func fail(_ url: String, status: Int) {
        routes.withLock { $0[url] = Route(body: "", etag: nil, status: status) }
    }

    func remove(_ url: String) {
        _ = routes.withLock { $0.removeValue(forKey: url) }
    }

    var requests: [UpstreamFetchRequest] { log.withLock { $0 } }

    func requestCount(matching fragment: String) -> Int {
        log.withLock { $0.count { $0.url.contains(fragment) } }
    }

    func resetLog() {
        log.withLock { $0.removeAll() }
    }

    func fetch(_ request: UpstreamFetchRequest) async throws(SourceError) -> UpstreamFetchResponse {
        log.withLock { $0.append(request) }
        guard let route = routes.withLock({ $0[request.url] }) else { return UpstreamFetchResponse(statusCode: 404) }
        if route.status != 200 { return UpstreamFetchResponse(statusCode: route.status) }
        if let etag = route.etag, request.ifNoneMatch == etag {
            return UpstreamFetchResponse(statusCode: 304, etag: etag)
        }
        return UpstreamFetchResponse(
            statusCode: 200,
            body: Array(route.body.utf8),
            etag: route.etag,
            contentType: "application/json"
        )
    }
}
