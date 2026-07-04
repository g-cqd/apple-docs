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

public struct URLSessionHTTPClient: HTTPClient {
    private let session: URLSession

    /// Inject a custom session (tests / a pinned trust store). Internal so `URLSession`
    /// (an internal Foundation import) stays out of the public surface.
    init(session: URLSession) {
        self.session = session
    }

    /// The default crawl session: ephemeral (no shared cache so `304` is observable
    /// rather than transparently served from cache), advertises gzip/deflate, and lifts
    /// the per-host connection cap to `maxConnectionsPerHost` (Foundation's default is 6,
    /// which would collapse a `maxConcurrency`-wide crawl to 6 in-flight requests against
    /// a single origin — the bottleneck on a latency-heavy host like developer.apple.com).
    public init(maxConnectionsPerHost: Int = 100) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpAdditionalHeaders = ["Accept-Encoding": "gzip, deflate"]
        configuration.httpMaximumConnectionsPerHost = Swift.max(1, maxConnectionsPerHost)
        self.session = URLSession(configuration: configuration)
    }

    public func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
        guard var urlRequest = URLRequest(httpRequest: request.head) else {
            throw HTTPClientError.malformedURL
        }
        urlRequest.timeoutInterval = Self.seconds(request.deadline)
        if let body = request.body { urlRequest.httpBody = Data(body) }

        do {
            let (data, response) = try await session.data(for: urlRequest)
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
