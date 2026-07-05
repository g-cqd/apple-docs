// URLSessionHTTPClient — the INTERIM `HTTPClient` conformer over Foundation
// URLSession, so Phase D3b (the crawl) proceeds before the production ADServe NIO
// client exists (rfcs/adserve-http-client-requirements.md §7). URLSession covers TLS,
// redirects, gzip/deflate transfer-decoding, connection pooling and a request timeout;
// this wraps it to the seam. Swapped out wholesale when the ADServe client lands —
// every adapter depends only on the `HTTPClient` protocol.
//
// v1 buffers the body (`data(for:)`): correct for the small JSON/HTML the crawl mostly
// fetches. Streaming-to-disk for the large-archive path (the RFC's hard requirement)
// is the production client's job; the `ResponseBody` seam already supports a streamed
// backing, so that swap is conformer-local.
import Foundation
import HTTPTypes
import HTTPTypesFoundation

#if canImport(FoundationNetworking)
    import FoundationNetworking  // URLSession/URLRequest live here on Linux (the Foundation split)
#endif

public struct URLSessionHTTPClient: HTTPClient {
    /// A pool of independent sessions. Each `URLSession` keeps its OWN connection pool, so with
    /// HTTP/2 (one multiplexed connection per session to a given origin) N sessions == N
    /// connections == N× the server's per-connection concurrent-stream budget. Measured:
    /// developer.apple.com caps ~65 in-flight streams per connection, so a single session
    /// plateaus a 256-wide crawl at ~60 pages/s; pooling lifts that near-linearly.
    private let sessions: [URLSession]

    /// Inject a custom session (tests / a pinned trust store). Internal so `URLSession`
    /// (an internal Foundation import) stays out of the public surface.
    init(session: URLSession) {
        self.sessions = [session]
    }

    /// The default crawl session: ephemeral (no shared cache so `304` is observable
    /// rather than transparently served from cache), advertises gzip/deflate, and lifts
    /// the per-host connection cap to `maxConnectionsPerHost` (Foundation's default is 6,
    /// which would collapse a `maxConcurrency`-wide crawl to 6 in-flight requests against
    /// a single origin — the bottleneck on a latency-heavy host like developer.apple.com).
    public init(maxConnectionsPerHost: Int = 100, connections: Int = 1) {
        self.sessions = (0 ..< Swift.max(1, connections))
            .map { _ in
                let configuration = URLSessionConfiguration.ephemeral
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                configuration.httpAdditionalHeaders = ["Accept-Encoding": "gzip, deflate"]
                configuration.httpMaximumConnectionsPerHost = Swift.max(1, maxConnectionsPerHost)
                return URLSession(configuration: configuration)
            }
    }

    /// Pick the pool session for a request by a stable FNV-1a hash of its origin+path, so the
    /// in-flight streams spread evenly across the connections with no shared cursor (keeps the
    /// conformer a value type + lock-free). Single-session pools short-circuit.
    private func session(for request: HTTPClientRequest) -> URLSession {
        guard sessions.count > 1 else { return sessions[0] }
        let key = (request.head.authority ?? "") + (request.head.path ?? "")
        var hash: UInt64 = 1_469_598_103_934_665_603  // FNV-1a offset basis
        for byte in key.utf8 { hash = (hash ^ UInt64(byte)) &* 1_099_511_628_211 }
        return sessions[Int(hash % UInt64(sessions.count))]
    }

    public func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
        guard var urlRequest = URLRequest(httpRequest: request.head) else {
            throw HTTPClientError.malformedURL
        }
        urlRequest.timeoutInterval = Self.seconds(request.deadline)
        if let body = request.body { urlRequest.httpBody = Data(body) }

        do {
            let (data, response) = try await session(for: request).data(for: urlRequest)
            guard let httpResponse = (response as? HTTPURLResponse)?.httpResponse else {
                throw HTTPClientError.connectionFailed("non-HTTP response")
            }
            return HTTPClientResponse(
                status: httpResponse.status,
                headerFields: httpResponse.headerFields,
                body: ResponseBody(buffered: Array(data)))
        } catch let error as HTTPClientError {
            throw error
        } catch let error as URLError {
            throw Self.map(error)
        } catch {
            if Task.isCancelled { throw HTTPClientError.cancelled }
            throw HTTPClientError.connectionFailed("\(error)")
        }
    }

    /// `Duration` → seconds (URLRequest's `timeoutInterval` is a `TimeInterval`).
    static func seconds(_ duration: Duration) -> TimeInterval {
        let components = duration.components
        return Double(components.seconds) + Double(components.attoseconds) / 1e18
    }

    /// Map a `URLError` to the seam's typed transport fault.
    static func map(_ error: URLError) -> HTTPClientError {
        switch error.code {
            case .timedOut: return .deadlineExceeded
            case .cancelled: return .cancelled
            case .badURL, .unsupportedURL: return .malformedURL
            case .secureConnectionFailed, .serverCertificateUntrusted,
                .serverCertificateHasBadDate, .serverCertificateNotYetValid,
                .clientCertificateRejected:
                return .tls("\(error.code)")
            case .httpTooManyRedirects: return .tooManyRedirects(0)
            default: return .connectionFailed("\(error.code)")
        }
    }
}
