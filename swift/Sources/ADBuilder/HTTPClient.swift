// HTTPClient — the transport SEAM the native crawler codes against. The concrete
// contract from rfcs/adserve-http-client-requirements.md (D2.5): the crawler depends
// ONLY on this protocol, so the interim `URLSessionHTTPClient` (now) and the ADServe
// NIO client (later) are swappable with no call-site changes.
//
// Layering: this is TRANSPORT (status + headers + streamed body, deadline,
// cancellation, typed faults). Retry/backoff + rate-limiting are POLICY the crawler
// builds on top — the transport never swallows an HTTP status (404/429/5xx/304 come
// back as responses, not errors), so the policy layer can act on them faithfully.
//
// Types are modeled on `swift-http-types` (the family-standard HTTP model), so a
// request head is an `HTTPRequest` and a response is an `HTTPResponse.Status` +
// `HTTPFields`. Foundation-free — the value types are pure stdlib + HTTPTypes.
public import HTTPTypes

/// The transport seam. `Sendable` so one client instance is shared across concurrent
/// crawl tasks (the client owns the connection pool).
public protocol HTTPClient: Sendable {
    /// Send `request` and return the response head plus a streamed body. Honors
    /// `request.deadline` (whole-request) and cooperative `Task` cancellation. An
    /// HTTP status is NOT an error; only transport faults (``HTTPClientError``) throw.
    func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse
}

/// A request: the swift-http-types head (method + scheme + authority + path + fields),
/// an optional body (nil for the crawl's GET/HEAD), a whole-request deadline, and a
/// redirect policy.
public struct HTTPClientRequest: Sendable {
    public var head: HTTPRequest
    /// Request body bytes; `nil` for GET/HEAD (the crawl's only methods today).
    public var body: [UInt8]?
    /// Whole-request budget (connect + headers + body). JS default 30 s.
    public var deadline: Duration
    /// Follow `3xx` (bounded) or surface it.
    public var redirect: RedirectPolicy

    public enum RedirectPolicy: Sendable, Equatable {
        case disallow
        /// Follow up to `max` hops; cross-origin hops drop `Authorization` (SSRF hygiene).
        case follow(max: Int)
    }

    public init(
        _ head: HTTPRequest, body: [UInt8]? = nil,
        deadline: Duration = .seconds(30), redirect: RedirectPolicy = .follow(max: 5)
    ) {
        self.head = head
        self.body = body
        self.deadline = deadline
        self.redirect = redirect
    }
}

/// A response: the verbatim status, all header fields, and a streamed body.
public struct HTTPClientResponse: Sendable {
    /// The verbatim status (200, 304, 403, 404, 429, 5xx, …) — never collapsed.
    public var status: HTTPResponse.Status
    /// All response header fields (case-insensitive). Read ETag / Last-Modified /
    /// Retry-After / X-RateLimit-* / Content-Type here.
    public var headerFields: HTTPFields
    /// The streamed (already transfer-decoded) body.
    public var body: ResponseBody

    public init(status: HTTPResponse.Status, headerFields: HTTPFields, body: ResponseBody) {
        self.status = status
        self.headerFields = headerFields
        self.body = body
    }

    /// The `ETag` validator (conditional-GET bookkeeping), if present.
    public var etag: String? { headerFields[.eTag] }
    /// The `Last-Modified` validator, if present.
    public var lastModified: String? { headerFields[.lastModified] }
}

/// The response body as an async byte-chunk stream with a size-bounded collector.
/// Backed by an `AsyncThrowingStream`, so the production client streams large
/// archives to disk while the interim client can buffer small docs (``init(buffered:)``).
public struct ResponseBody: AsyncSequence, Sendable {
    public typealias Element = ArraySlice<UInt8>
    public typealias Failure = any Error

    private let stream: AsyncThrowingStream<ArraySlice<UInt8>, any Error>

    /// Wrap a producer's byte-chunk stream (the streaming path).
    public init(_ stream: AsyncThrowingStream<ArraySlice<UInt8>, any Error>) {
        self.stream = stream
    }

    /// A fully-in-memory body (the interim client's small-doc path).
    public init(buffered bytes: [UInt8]) {
        self.stream = AsyncThrowingStream { continuation in
            if !bytes.isEmpty { continuation.yield(bytes[...]) }
            continuation.finish()
        }
    }

    public func makeAsyncIterator() -> AsyncThrowingStream<ArraySlice<UInt8>, any Error>.Iterator {
        stream.makeAsyncIterator()
    }

    /// Buffer the whole body, throwing ``HTTPClientError/bodyTooLarge(limit:)`` past
    /// `maxBytes` — an OOM guard against a hostile/absent `Content-Length`. The
    /// small-doc path uses this; the large-archive path iterates and writes to disk.
    public func collect(upTo maxBytes: Int) async throws -> [UInt8] {
        var out: [UInt8] = []
        for try await chunk in stream {
            if out.count + chunk.count > maxBytes {
                throw HTTPClientError.bodyTooLarge(limit: maxBytes)
            }
            out.append(contentsOf: chunk)
        }
        return out
    }
}

/// Typed TRANSPORT faults (never an HTTP status). Maps the JS retryable/terminal split
/// the policy layer keys off (`fetch-with-retry.js` `classifyFetchError`).
public enum HTTPClientError: Error, Sendable, Equatable {
    case malformedURL  // terminal
    case unsupportedScheme(String)  // terminal
    case connectionFailed(String)  // retryable (DNS / connect / reset)
    case tls(String)  // retryable
    case deadlineExceeded  // retryable
    case cancelled  // propagate, never retry
    case tooManyRedirects(Int)
    case bodyTooLarge(limit: Int)
}
