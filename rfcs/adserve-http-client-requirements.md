# ADServe HTTP **client** — requirements for the native crawler

- **Status**: Requirements / handover (Draft).
- **Audience**: the ADServe task force (owners of `g-cqd/ADServe`). This is a repo
  handover doc, not product documentation — it specifies what apple-docs' native
  crawler (`ADBuilder`) needs from a family HTTP **client** so the two streams can
  build in parallel.
- **Parent**: [RFC 0001 §7](0001-swift-native-transition.md) (the Bun→Swift
  transition) — Phase D3b ports the crawl (`src/sources/*` + `src/pipeline/*`); this
  doc is the D2.5 deliverable that unblocks it.
- **Driver**: apple-docs `ADBuilder` (new target). It crawls developer.apple.com,
  GitHub, swift.org, … and persists via `ADWrite`. The crawl is the last JS the
  transition retires.

## 1. Why this exists

`ADServe` today is a **server**: it *accepts* connections (`ADServeCore` over
swift-nio, NIOSSL, swift-http-types). The crawler needs the mirror image — a
**client** that *initiates* requests. No such surface exists in the family yet, so
`ADBuilder` is being built against a narrow `HTTPClient` **protocol seam** (§5) with
an **interim `URLSession` conformer** (§7). That keeps the crawler unblocked while
the task force builds the production NIO-backed client behind the same protocol.

The ask: **own and ship an `ADServe` client** that conforms to (or supersedes, with
review) the `HTTPClient` protocol in §5, reusing ADServe's existing TLS/HTTP
machinery. When it lands, `ADBuilder` swaps the conformer with **zero call-site
changes** — every adapter depends only on the protocol.

The behavior to reproduce is the current Bun crawler:
`src/lib/fetch-with-retry.js` (229 L) and `src/lib/rate-limiter.js` (61 L). Every
numeric default and header rule below is lifted from those files so the native crawl
is byte-faithful to the JS one (the D3b parity gate compares native vs JS output).

## 2. Scope split — transport vs. policy

Two layers, kept separate so the client stays reusable across the family:

| Layer | Owner | Responsibility |
| --- | --- | --- |
| **Transport** (this doc, §4) | ADServe client | TLS, connection reuse, redirects, transfer-decoding, per-request deadline + cancellation, surfacing status + headers + a streamed body **verbatim** (no status swallowing). |
| **Policy** (ADBuilder, §6) | apple-docs | Retry/backoff, rate-limiting, conditional-GET bookkeeping, error classification → typed crawl errors. |

The transport MUST NOT bake in retry or rate-limiting. It MUST expose enough
(unmodified status codes, response headers, typed transport errors) for ADBuilder to
implement the policy faithfully. Rationale: GitHub vs developer.apple.com need
different retry/limit policy; the JS keeps that in `fetch-with-retry.js`, not in
`fetch`.

## 3. Traffic profile (what the crawler actually does)

- **Methods**: `GET` (fetch a doc/JSON/archive) and `HEAD` (cheap change-check).
  No `POST`/`PUT`/… today — but don't preclude them.
- **Schemes**: `https` only in production; allow `http` for a local fixture server
  in tests.
- **Bodies**: small JSON / HTML (KBs) **and** large archives (`apple-archive` zips,
  model bundles — tens–hundreds of MB). The large ones MUST stream to disk, never
  buffer whole in RAM.
- **Concurrency**: many small requests, host-bounded (a token bucket, §6.2). Expect
  ~5 req/s steady with bursts; connection reuse to one origin matters.
- **Hosts**: `developer.apple.com`, `api.github.com` / `raw.githubusercontent.com`,
  `swift.org`, `download.swift.org`, plus a handful of mirrors.

## 4. Transport requirements (the client MUST provide)

### 4.1 Methods & request shape
- Async `GET` and `HEAD`. Arbitrary request header fields (the crawler sets
  `User-Agent`, `Authorization` for GitHub, `Accept`, and the conditional headers
  in §4.2).
- A request carries: method, URL, header fields, optional body, a **deadline**, and
  a **redirect policy** (§4.4).

### 4.2 Conditional GET / HEAD (change detection — REQUIRED)
The incremental crawl lives on this. The client must let the caller **set** request
validators and **read** response validators, and surface `304` as a first-class
status (never collapse it into 200 or an error):
- Request: `If-None-Match: <etag>` and/or `If-Modified-Since: <http-date>`.
- Response: expose `ETag` and `Last-Modified`, and the raw status so `304 Not
  Modified` is observable. (JS `checkResourceEtag`: `304 → unchanged`,
  `404 → deleted`, `2xx → modified` carrying the new `ETag`; see §6.4.)

### 4.3 Response surface
- Status code (unmodified — including `3xx` if redirects are disabled, `304`,
  `403`, `404`, `429`, `5xx`).
- **All** response header fields (case-insensitive access). The policy layer reads
  `Retry-After`, `ETag`, `Last-Modified`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset`, `Content-Length`, `Content-Type`.
- A **streamed** body: an `AsyncSequence` of byte chunks **plus** a convenience
  `collect(upTo:)` that enforces a max size (so a hostile `Content-Length` can't
  OOM the crawler). Streaming is mandatory for the large-archive path.

### 4.4 Redirects
- A per-request policy: **follow** (with a max hop count, default ~5) or
  **disallow** (surface the `3xx` + `Location`). Apple/GitHub/swift.org all use
  cross-host redirects (e.g. `raw.githubusercontent.com`, CDN hops), so following
  is the default for the crawl. Drop `Authorization` on cross-origin redirects
  (SSRF/credential-leak hygiene — see §8).

### 4.5 TLS
- TLS 1.2+ (prefer 1.3), standard system trust roots. **Reuse ADServe's NIOSSL**
  configuration surface rather than introducing a second TLS stack. No custom
  pinning required for the public crawl; do expose a hook for a custom trust
  store so tests can point at a local fixture server.

### 4.6 Deadlines & cancellation (REQUIRED)
- A **whole-request deadline** (connect + TTFB + body). JS uses
  `AbortSignal.timeout(timeout)` with `timeout = 30000` ms default.
- **Cooperative cancellation**: honor Swift `Task` cancellation at every await
  point (DNS, connect, TLS, header wait, each body chunk) and on the streamed body.
  JS composes a caller `AbortSignal` with the timeout via `AbortSignal.any`; the
  Swift idiom is structured concurrency + the deadline. A cancelled request MUST
  throw promptly and free the connection.

### 4.7 Connection reuse, pooling, max-concurrency
- HTTP/1.1 keep-alive (HTTP/2 where offered) with a **connection pool** keyed by
  origin. Bounded: a max connections-per-host and a global max. The crawler's
  throughput depends on not re-handshaking TLS per request to the same origin.
- Expose the per-host / global caps as config (ADBuilder sets them alongside the
  rate limiter so the two agree).

### 4.8 Transfer decoding
- Transparent `gzip` and `deflate` **content/transfer decoding** (send
  `Accept-Encoding`, decode the body). developer.apple.com and GitHub gzip JSON.
  The decoded bytes are what the caller sees; `Content-Length` semantics follow the
  decoded stream for `collect(upTo:)` budgeting. (JS gets this free from `fetch`;
  the native client must do it explicitly.)

### 4.9 Errors (typed)
Distinguish, as typed cases, at minimum:
- **transport/transient** — DNS failure, connect refused/reset, TLS failure, read
  timeout, deadline exceeded. (Policy treats these as *retryable*.)
- **terminal** — malformed URL, unsupported scheme. (Policy treats these as
  *non-retryable* — surface the bug.) This is the JS `classifyFetchError`
  split: a `TypeError` with no `cause` is terminal; one with a `cause` (socket/
  DNS/TLS) is retryable.
- **cancelled** — distinct from timeout, so the caller can tell "we aborted" from
  "server too slow".
HTTP status codes are **not** errors at the transport layer — `404`/`429`/`5xx` are
returned as responses; the policy layer decides their meaning.

## 5. Proposed `HTTPClient` protocol (the seam ADBuilder codes against)

Modeled on `swift-http-types` (already an ADServe/ad-server dependency) so request/
response/header types are the family standard, not a bespoke model. `ADBuilder`
depends ONLY on this protocol; the production client and the interim URLSession
conformer (§7) both implement it.

```swift
public import HTTPTypes   // apple/swift-http-types: HTTPRequest, HTTPResponse, HTTPFields

/// The transport seam. Conformers: the interim URLSession client (now) and the
/// ADServe NIO client (later). Sendable so adapters can share one instance across
/// concurrent crawl tasks; the client owns the connection pool.
public protocol HTTPClient: Sendable {
    /// Send `request`, returning the response head and a streamed, transfer-decoded
    /// body. Honors `request.deadline` (whole-request) and cooperative `Task`
    /// cancellation. HTTP status is NOT an error — `404`/`429`/`5xx`/`304` come back
    /// as responses; only transport faults (§4.9) throw.
    func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse
}

public struct HTTPClientRequest: Sendable {
    /// method + scheme + authority + path + header fields (swift-http-types).
    public var head: HTTPRequest
    /// Request body; `nil` for GET/HEAD (the crawl's only methods today).
    public var body: Body?
    /// Whole-request budget (connect + headers + body). JS default 30 s.
    public var deadline: Duration
    /// Follow `3xx` (bounded) or surface it. Default `.follow(max: 5)`.
    public var redirect: RedirectPolicy

    public enum Body: Sendable {
        case bytes([UInt8])
        case stream(any AsyncSequence<ArraySlice<UInt8>, any Error> & Sendable)
    }
    public enum RedirectPolicy: Sendable {
        case disallow
        /// Follow up to `max` hops; drop `Authorization` on cross-origin hops.
        case follow(max: Int)
    }

    public init(
        _ head: HTTPRequest, body: Body? = nil,
        deadline: Duration = .seconds(30), redirect: RedirectPolicy = .follow(max: 5))
}

public struct HTTPClientResponse: Sendable {
    /// The verbatim status (200, 304, 403, 404, 429, 5xx, …).
    public var status: HTTPResponse.Status
    /// All response header fields (case-insensitive). Read ETag / Last-Modified /
    /// Retry-After / X-RateLimit-* / Content-Length / Content-Type here.
    public var headerFields: HTTPFields
    /// Streamed, already transfer-decoded (gzip/deflate) body.
    public var body: ResponseBody
}

/// The response body as an async byte stream with a size-bounded collector.
public struct ResponseBody: AsyncSequence, Sendable {
    public typealias Element = ArraySlice<UInt8>
    public func makeAsyncIterator() -> AsyncIterator
    /// Buffer the whole body, throwing if it exceeds `maxBytes` (OOM guard for a
    /// hostile/absent Content-Length). The small-doc path uses this; the
    /// large-archive path iterates and writes to disk.
    public func collect(upTo maxBytes: Int) async throws -> [UInt8]
}

/// Typed transport faults (NOT HTTP status). Maps the JS retryable/terminal split.
public enum HTTPClientError: Error, Sendable {
    case malformedURL                 // terminal
    case unsupportedScheme(String)    // terminal
    case connectionFailed(any Error)  // retryable (DNS/connect/reset)
    case tls(any Error)               // retryable
    case deadlineExceeded             // retryable
    case cancelled                    // neither — propagate
    case tooManyRedirects(Int)
    case bodyTooLarge(limit: Int)
}
```

Notes for review:
- `AsyncSequence<Element, Failure>` (the primary-associated-type form) needs the
  Swift 6.x toolchain the family already targets; if the floor is a concern, fall
  back to a concrete `ResponseBody` element type and an internal box for the
  request stream.
- If ADServe prefers `ByteBuffer` over `ArraySlice<UInt8>` at the boundary, that's
  acceptable — ADBuilder will adapt. The hard requirements are *streaming*,
  *deadline*, *cancellation*, *verbatim status+headers*.

## 6. Policy layer (ADBuilder builds this ON TOP — for context, not your scope)

Documented so the transport surface is sufficient for it. This is the faithful port
of the JS files; it consumes `HTTPClient`.

### 6.1 Retry/backoff (`fetchWithRetry`)
- Retryable statuses: **`408, 429, 500, 502, 503, 504`**. Plus a *recoverable*
  `403` when `X-RateLimit-Remaining: 0` **or** any `Retry-After` is present
  (GitHub secondary-rate-limit). A plain `403` is terminal.
- `maxRetries = 3`. Backoff = `min(1000 · 2^attempt, 8000)` ms, but **honor
  upstream**: take the max of backoff, `Retry-After` (seconds), and
  `X-RateLimit-Reset` (epoch seconds → ms, capped at 60 s). Add `jitterMs = 250`
  random jitter.
- Transport faults classified per §4.9: retryable faults retry (same backoff),
  terminal faults throw immediately, cancellation propagates (never retries).
- ⇒ Transport obligation: return unmodified status + the `Retry-After` /
  `X-RateLimit-*` headers; surface the typed faults of §4.9.

### 6.2 Rate limiter (`rate-limiter.js`)
- **Token bucket**: `rate` tokens/sec (default 5), `burst` capacity (default 2);
  `acquire()` awaits a token. ADBuilder owns this `actor RateLimiter` and calls
  `acquire()` before each `send`.
- ⇒ Transport obligation: just the per-host / global connection caps (§4.7) so the
  two limits agree; the token bucket itself is ADBuilder's.

### 6.3 GET decode
- `parseAs: 'json' | 'text'` → decode `collect(upTo:)` bytes as UTF-8 JSON/text.
  Return `{ data|text, etag, lastModified }`.

### 6.4 HEAD change-check (`checkResourceEtag`)
- `HEAD` + `If-None-Match: <prev etag>` → `304 → unchanged`, `404 → deleted`,
  `2xx → modified` (carry new `ETag`), else `error`.

## 7. Interim `URLSession` conformer (ships with ADBuilder now)

So D3b proceeds before the production client exists. macOS/Linux `URLSession`
covers TLS, redirects, gzip, pooling, and timeouts; ADBuilder wraps it to the §5
protocol. Swapped out wholesale when the ADServe client lands.

```swift
import Foundation
import HTTPTypes

/// Interim transport over Foundation URLSession. Replace with the ADServe client.
public struct URLSessionHTTPClient: HTTPClient {
    private let session: URLSession

    public init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.httpShouldUsePipelining = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: configuration)
    }

    public func send(_ request: HTTPClientRequest) async throws -> HTTPClientResponse {
        var urlRequest = try URLRequest(httpRequest: request.head)  // HTTPTypesFoundation bridge
        urlRequest.timeoutInterval = request.deadline.seconds
        // … set body, redirect delegate (drop Authorization cross-origin) …
        let (bytes, response) = try await session.bytes(for: urlRequest)  // streamed; honors Task cancel
        guard let http = response as? HTTPURLResponse else { throw HTTPClientError.connectionFailed(…) }
        return HTTPClientResponse(
            status: .init(integerLiteral: http.statusCode),
            headerFields: http.httpFields,            // bridged
            body: ResponseBody(bytes))                // URLSession.AsyncBytes → chunks
    }
}
```

Caveats (why it's interim, not final): `URLSession.bytes` gives line/byte streaming
but coarse control over the connection pool and per-phase deadlines; redirect
`Authorization` stripping needs a delegate; `304` handling requires
`reloadIgnoringLocalCacheData` (else URLSession may transparently serve from cache).
The NIO client fixes the pooling/observability gaps.

## 8. Security / supply-chain constraints (RFC 0001 §2)

- No new third-party org. The production client uses **apple/swift-nio*,
  apple/swift-http-types, apple/swift-nio-ssl** — all already in the ad-server graph
  — or Foundation. No new HTTP library.
- SSRF/credential hygiene: **drop `Authorization` (and `Cookie`) on cross-origin
  redirects**; bound redirect hops; bound response size (`collect(upTo:)`); the
  crawler only ever talks to an allow-list of hosts (§3), enforced ADBuilder-side.
- Validate `Location` is an absolute `https`/`http` URL before following; reject
  redirects to non-HTTP schemes.

## 9. Acceptance criteria (definition of done for the ADServe client)

1. Conforms to `HTTPClient` (§5) — or a task-force-reviewed evolution of it — so the
   ADBuilder `URLSessionHTTPClient` swap is call-site-free.
2. `GET` + `HEAD`; conditional headers in, `ETag`/`Last-Modified`/`304` observable.
3. Whole-request deadline + cooperative `Task` cancellation, verified by a test that
   cancels mid-body and asserts prompt throw + connection release.
4. Streamed body with `collect(upTo:)` size guard; a >100 MB download streams with
   bounded RAM.
5. Bounded redirects with cross-origin `Authorization` stripping.
6. gzip/deflate decode transparent.
7. Connection pooling with per-host + global caps (config).
8. Typed transport errors per §4.9; HTTP status never thrown.
9. Reuses ADServe's NIOSSL; no new third-party dependency.
10. A conformance test-suite ADBuilder can run against BOTH the interim and the
    production client (same assertions) — the swap's safety net.

## 10. Open questions for the task force

- **Home**: a new `ADServeClient` product in `g-cqd/ADServe`, or a standalone
  `ADHTTPClient` package? (ADBuilder doesn't care — it sees only the protocol.)
- **Body type at the boundary**: `ArraySlice<UInt8>` vs `ByteBuffer`. Pick one;
  ADBuilder adapts.
- **HTTP/2**: needed for any crawl origin, or HTTP/1.1 keep-alive enough for v1?
- **Built-in retry?** This doc keeps retry in ADBuilder (policy). If the task force
  wants a reusable retry/backoff in the client, expose it as an *optional* wrapper so
  the raw transport stays policy-free.
- **Timeline**: ADBuilder ships on the URLSession conformer regardless; when do you
  expect the NIO client, so we schedule the swap + the §9.10 conformance run?

## 11. Mapping to the retiring JS

| Native (target) | JS source | Notes |
| --- | --- | --- |
| `HTTPClient.send` (transport) | `fetch(...)` in `fetch-with-retry.js` | status+headers+streamed body, deadline, cancel |
| ADBuilder retry policy | `fetchWithRetry`, `retryDelayMs`, `classifyFetchError`, `isRecoverableForbidden` | §6.1 |
| ADBuilder `RateLimiter` actor | `rate-limiter.js` (`RateLimiter`) | §6.2 token bucket |
| ADBuilder HEAD check | `checkResourceEtag` | §6.4 |
| GET decode | `fetchWithRetry` `parseAs` branch | §6.3 |
