import Foundation

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

/// Cross-platform `URLSession`-backed ``UpstreamHTTPTransport`` (macOS `Foundation` + Linux `FoundationNetworking`)
/// with bounded body size enforcement and clean `ETag`/`Last-Modified`/`Retry-After` header extraction.
public final class URLSessionUpstreamTransport: UpstreamHTTPTransport, Sendable {
    private let userAgent: String

    public init(userAgent: String = "apple-docs-swift/2.0") {
        self.userAgent = userAgent
    }

    public func fetch(_ request: UpstreamFetchRequest) async throws(SourceError) -> UpstreamFetchResponse {
        guard let url = URL(string: request.url) else {
            throw .unsafeURL(request.url, reason: "malformed URL")
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.timeoutInterval = 30
        urlRequest.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        urlRequest.setValue(request.accept, forHTTPHeaderField: "Accept")
        if let etag = request.ifNoneMatch, !etag.isEmpty {
            urlRequest.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        if let modified = request.ifModifiedSince, !modified.isEmpty {
            urlRequest.setValue(modified, forHTTPHeaderField: "If-Modified-Since")
        }

        let data: Data
        let rawResponse: URLResponse
        do {
            (data, rawResponse) = try await URLSession.shared.data(for: urlRequest)
        } catch {
            throw .networkFailure(String(describing: error))
        }
        guard data.count <= request.maxBodyBytes else {
            throw .responseTooLarge(limitBytes: request.maxBodyBytes)
        }
        guard let http = rawResponse as? HTTPURLResponse else {
            throw .networkFailure("Non-HTTP response for \(request.url)")
        }
        let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(Int.init)
        return UpstreamFetchResponse(
            statusCode: http.statusCode,
            body: Array(data),
            etag: http.value(forHTTPHeaderField: "ETag"),
            lastModified: http.value(forHTTPHeaderField: "Last-Modified"),
            contentType: http.value(forHTTPHeaderField: "Content-Type"),
            retryAfterSeconds: retryAfter
        )
    }
}
