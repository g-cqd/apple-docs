// ADServeCore — the ad-server ENGINE (RFC 0005). The optimizable server layer:
// the value types a request/response flows through, the connection pool, the
// hashing/request-id helpers, and the routing contract the DSL satisfies. The NIO
// bootstrap + the response-writing envelope live in HTTPServer.swift. Headers and
// status are swift-http-types value types throughout (RFC 0006 H1) — no stringly
// tuples. The engine knows nothing route-specific.

import Crypto
import Foundation
import HTTPTypes
import Logging
import ADStorage
import Synchronization

// MARK: - Configuration

/// Engine bootstrap parameters (host/port/pool sizing). siteConfig + the response
/// envelope are the app's concern, passed in separately.
public struct ServerConfiguration: Sendable {
  public var host: String
  public var port: Int
  public var threadCount: Int
  public var loopCount: Int

  public init(host: String = "127.0.0.1", port: Int = 3032, threadCount: Int, loopCount: Int = 2) {
    self.host = host
    self.port = port
    self.threadCount = max(1, threadCount)
    self.loopCount = max(1, loopCount)
  }
}

// MARK: - Connection pool

/// A fixed pool of `StorageConnection`s. Checkout happens INSIDE the offload work
/// closure, so at most `count` (= thread count) are out at once and checkout never
/// blocks; the free-list is a `Mutex` (not an actor — a trivial pop/append critical
/// section, no serial-executor funnel). One connection is touched by one thread at a
/// time, so the C handle's no-lock invariant holds.
public final class ConnectionPool: Sendable {
  private let free: Mutex<[StorageConnection]>
  public let count: Int

  public init?(path: String, count: Int) {
    var conns: [StorageConnection] = []
    for _ in 0..<max(1, count) {
      guard let conn = StorageConnection(path: path) else { return nil }
      conns.append(conn)
    }
    free = Mutex(conns)
    self.count = conns.count
  }

  public func checkout() -> StorageConnection? { free.withLock { $0.popLast() } }
  public func checkin(_ conn: StorageConnection) { free.withLock { $0.append(conn) } }
}

// MARK: - Request / response value types

/// The request as the DSL/app see it — pure swift-http-types, no NIO leakage.
public struct ServerRequest: Sendable {
  public let method: HTTPRequest.Method
  /// The request target (path + optional `?query`), i.e. the `:path` pseudo-header.
  public let target: String
  public let headers: HTTPFields

  public init(method: HTTPRequest.Method, target: String, headers: HTTPFields) {
    self.method = method
    self.target = target
    self.headers = headers
  }

  /// The path with any `?query` stripped.
  public var path: Substring { target.prefix { $0 != "?" } }
}

/// What a handler returns. The cross-cutting envelope (security set, Link, Vary,
/// request-id) + cache-control/ETag are applied by the engine, not here.
public enum ResponseContent: Sendable {
  /// A body with an explicit content-type + status.
  case raw(body: [UInt8], contentType: String, status: HTTPResponse.Status)
  /// 404 with the body `Not Found` (a route-level miss — distinct from the engine's
  /// own unmatched-path 404, which is `not found\n`).
  case notFound
  /// A `text/plain` status response (405, the engine's 404, a 503 fallback, …).
  case plain(HTTPResponse.Status, String)

  /// JSON body. Defaults to Bun's `Response.json` content-type; pass `contentType`
  /// to override (e.g. `/search` emits `application/json` with no charset).
  public static func json(_ bytes: [UInt8], contentType: String = "application/json;charset=utf-8")
    -> ResponseContent
  {
    .raw(body: bytes, contentType: contentType, status: .ok)
  }

  /// A text body with an explicit content-type.
  public static func text(_ bytes: [UInt8], contentType: String) -> ResponseContent {
    .raw(body: bytes, contentType: contentType, status: .ok)
  }
}

/// Per-route cache policy: the `Cache-Control` value (if any) + whether to attach a
/// SHA-256-prefix `ETag` (and honor `If-None-Match` → 304). The named app values
/// (apiCorpus, discovery, …) are app extensions.
public struct CachePolicy: Sendable {
  public var cacheControl: String?
  public var etag: Bool

  public init(cacheControl: String? = nil, etag: Bool = false) {
    self.cacheControl = cacheControl
    self.etag = etag
  }

  public static let unset = CachePolicy()
  public static let noStore = CachePolicy(cacheControl: "no-store")
  public static let noCache = CachePolicy(cacheControl: "no-cache")
  public static let immutable = CachePolicy(cacheControl: "public, max-age=31536000, immutable")
}

// MARK: - Routing contract (the engine ⇄ DSL seam)

/// The per-request inputs the engine hands a matched route's `run`.
public struct HandlerInput: Sendable {
  public let request: ServerRequest
  /// Present iff the route declared `.storage` (checked out for the call).
  public let connection: StorageConnection?
  public let logger: Logger
  public let requestID: String

  public init(
    request: ServerRequest, connection: StorageConnection?, logger: Logger, requestID: String
  ) {
    self.request = request
    self.connection = connection
    self.logger = logger
    self.requestID = requestID
  }
}

/// A route the engine resolved for a request: whether it needs a pooled connection,
/// its cache policy, and the bound (captures-applied) handler. `run` is synchronous —
/// the business logic is sync and runs on the offload thread for `.storage` routes.
public struct MatchedRoute: Sendable {
  public let needsStorage: Bool
  public let cache: CachePolicy
  public let run: @Sendable (HandlerInput) -> ResponseContent

  public init(
    needsStorage: Bool, cache: CachePolicy, run: @escaping @Sendable (HandlerInput) -> ResponseContent
  ) {
    self.needsStorage = needsStorage
    self.cache = cache
    self.run = run
  }
}

public enum RouteMatch: Sendable {
  case matched(MatchedRoute)
  case methodNotAllowed
  case notFound
}

/// The route table the engine dispatches against. The DSL's `RouteTable` conforms.
public protocol HTTPHandling: Sendable {
  func match(method: HTTPRequest.Method, path: Substring) -> RouteMatch
}

// MARK: - Hashing / conditional / request-id (engine-generic HTTP)

/// Lowercase-hex SHA-256 (matches JS `Bun.CryptoHasher('sha256').digest('hex')`).
/// The `hashable`→ETag path and the app's `/data/search/*.<hash>.json` filenames both
/// use it, so it lives here once.
public func sha256HexLower(_ bytes: [UInt8]) -> String {
  var hasher = SHA256()
  bytes.withUnsafeBytes { hasher.update(bufferPointer: $0) }
  let hex: [UInt8] = Array("0123456789abcdef".utf8)
  var out = [UInt8]()
  out.reserveCapacity(64)
  for b in hasher.finalize() {
    out.append(hex[Int(b >> 4)])
    out.append(hex[Int(b & 0xF)])
  }
  return String(decoding: out, as: UTF8.self)
}

/// Loose RFC 7232 `If-None-Match` (src/web/responses.js matchesIfNoneMatch): `*`, a
/// single tag, or a comma list; the strong/weak prefix is compared verbatim.
public func matchesIfNoneMatch(_ headerValue: String, _ etag: String) -> Bool {
  let value = trimOWS(headerValue[...])
  if value == "*" { return true }
  for part in value.split(separator: ",") where trimOWS(part) == etag[...] { return true }
  return false
}

private func trimOWS(_ s: Substring) -> Substring {
  var sub = s
  while let f = sub.first, f == " " || f == "\t" { sub = sub.dropFirst() }
  while let l = sub.last, l == " " || l == "\t" { sub = sub.dropLast() }
  return sub
}

/// Echo a valid inbound `X-Request-Id` (`/^[A-Za-z0-9._:+/=-]{1,128}$/`, src/web/
/// serve.js), else mint a lowercase v4 UUID (the parity regex requires lowercase).
public func resolveRequestID(_ headers: HTTPFields) -> String {
  if let incoming = headers[requestIDName], isValidRequestID(incoming) { return incoming }
  return UUID().uuidString.lowercased()
}

/// `x-request-id` — defined once (a valid lowercase token name).
public let requestIDName = HTTPField.Name("x-request-id")!

private func isValidRequestID(_ s: String) -> Bool {
  let utf8 = s.utf8
  guard (1...128).contains(utf8.count) else { return false }
  for b in utf8 {
    switch b {
    case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
      UInt8(ascii: "0")...UInt8(ascii: "9"):
      continue
    case UInt8(ascii: "."), UInt8(ascii: "_"), UInt8(ascii: ":"), UInt8(ascii: "+"),
      UInt8(ascii: "/"), UInt8(ascii: "="), UInt8(ascii: "-"):
      continue
    default:
      return false
    }
  }
  return true
}
