public import AemiHTTP

/// Answers `GET`/`HEAD` on `path` with the registry's Prometheus exposition; every other request passes through.
public struct MetricsEndpointMiddleware: HTTPMiddleware {
    private let registry: HTTPMetricsRegistry
    private let path: String

    public init(registry: HTTPMetricsRegistry, path: String = "/metrics") {
        self.registry = registry
        self.path = path
    }

    public func respond(
        to request: HTTPRequest,
        body: RequestBody,
        context: RequestContext,
        next: any HTTPResponder
    ) async -> ServerResponse {
        guard request.method == .get || request.method == .head, request.path == path else {
            return await next.respond(to: request, body: body, context: context)
        }
        var headers = HTTPFields()
        _ = headers.setValue("text/plain; version=0.0.4; charset=utf-8", for: .contentType)
        _ = headers.setValue("no-store", for: .cacheControl)
        return ServerResponse(
            HTTPResponse(status: .ok, headerFields: headers),
            body: Array(registry.renderPrometheus().utf8)
        )
    }
}
