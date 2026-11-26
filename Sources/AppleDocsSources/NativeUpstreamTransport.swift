import HTTPClient
import HTTPCore

/// Production ``UpstreamHTTPTransport`` over `g-cqd/HTTP`'s ``HTTPClient``: pooled HTTP/1.1 keep-alive
/// connections on the kqueue / epoll backbones with the in-house TLS 1.3 client (no `URLSession`, and no
/// libcurl / OpenSSL on Linux), `zstd` / `gzip` / `deflate` decoding, and no response cache — conditional
/// requests (`If-None-Match`) always reach the origin, so the sync orchestrator observes every `304`.
///
/// Redirects are not followed: the caller's SSRF policy validates every URL it fetches, so a `3xx` is
/// surfaced as a status rather than chased to an unvalidated host.
public final class NativeUpstreamTransport: UpstreamHTTPTransport, Sendable {
    private let userAgent: String
    private let client: HTTPClient

    /// Creates a transport allowing `maxConnectionsPerHost` simultaneous connections per origin
    /// (developer.apple.com serves HTTP/1.1, so in-flight requests need one connection each).
    public init(userAgent: String = "apple-docs-swift/2.0", maxConnectionsPerHost: Int = 32) {
        self.userAgent = userAgent
        var configuration = HTTPClientConfiguration()
        configuration.userAgent = userAgent
        configuration.maxConnectionsPerHost = max(1, min(maxConnectionsPerHost, 256))
        configuration.maxIdleConnectionsPerHost = configuration.maxConnectionsPerHost
        configuration.requestTimeout = .seconds(30)
        configuration.maxRedirects = 0
        self.client = HTTPClient(configuration: configuration)
    }

    deinit {
        // Pooled connections close with the client.
    }

    public func fetch(_ request: UpstreamFetchRequest) async throws(SourceError) -> UpstreamFetchResponse {
        var fields = HTTPFields()
        _ = fields.append(request.accept, for: .accept)
        if let etag = request.ifNoneMatch, !etag.isEmpty {
            _ = fields.append(etag, for: .ifNoneMatch)
        }
        if let modified = request.ifModifiedSince, !modified.isEmpty {
            _ = fields.append(modified, for: .ifModifiedSince)
        }
        for (name, value) in request.headers.sorted(by: { $0.key < $1.key }) {
            guard let fieldName = HTTPFieldName(name) else {
                throw .unsafeURL(request.url, reason: "invalid header name \(name)")
            }
            fields.removeAll(named: fieldName)
            _ = fields.append(value, for: fieldName)
        }
        let response: HTTPClientResponse
        do {
            response = try await client.execute(try Self.request(request, fields: fields))
        } catch .responseTooLarge {
            throw .responseTooLarge(limitBytes: request.maxBodyBytes)
        } catch {
            throw .networkFailure("\(request.url): \(error)")
        }
        guard response.body.count <= request.maxBodyBytes else {
            throw .responseTooLarge(limitBytes: request.maxBodyBytes)
        }
        let headers = response.headerFields
        return UpstreamFetchResponse(
            statusCode: Int(response.status.code),
            body: response.body,
            etag: headers[.etag],
            lastModified: headers[.lastModified],
            contentType: headers[.contentType],
            retryAfterSeconds: headers[.retryAfter].flatMap(Int.init)
        )
    }

    private static func request(
        _ request: UpstreamFetchRequest,
        fields: HTTPFields
    ) throws(HTTPClientError) -> HTTPRequest {
        guard let separator = request.url.firstRange(of: "://") else {
            throw .invalidRequest("not an absolute URL")
        }
        let scheme = String(request.url[..<separator.lowerBound]).lowercased()
        var rest = request.url[separator.upperBound...]
        if let hash = rest.firstIndex(of: "#") {
            rest = rest[..<hash]
        }
        let pathStart = rest.firstIndex { $0 == "/" || $0 == "?" } ?? rest.endIndex
        var path = String(rest[pathStart...])
        if !path.hasPrefix("/") {
            path = "/" + path
        }
        guard let method = HTTPMethod(rawValue: request.method) else {
            throw .invalidRequest("invalid method \(request.method)")
        }
        return HTTPRequest(
            method: method,
            scheme: scheme,
            authority: String(rest[..<pathStart]),
            path: path,
            headerFields: fields
        )
    }
}
