// A hierarchical, type-safe server-DEFINITION DSL (RFC 0005, proof-of-concept).
//
// Decouples the SERVER (the ADServeCore engine) from its DEFINITION (this DSL) from the
// BUSINESS LOGIC (the handler bodies). The definition leverages Swift type-safety
// end-to-end — typed HTTP verbs (GET/POST/OPTIONS), a typed pool that picks the handler's
// context type (so a pure-config route cannot touch the DB), typed cache + output
// (`MediaType`), result builders for the tree, and `@dynamicMemberLookup` on the context
// — and lowers to the existing `CompiledRoute`/`RouteTable` seam, so THE ENGINE IS
// UNCHANGED (one listener, the shared pool) and the parity suites stay the contract.
//
//   Server {
//     App(pool: .shared) {                        // an application on a port; the central shared pool
//       GET("search") { ctx in .json(…, as: .jsonRaw) }
//       Group("api") {                            // → /api/*
//         GET("filters") { ctx in .json(WebRoutes.filters(ctx.db)) }.cache(.apiCorpus)
//         Group("symbols") { GET("index.json") { ctx in … }.etag }
//       }
//       Group("discovery", pool: .none) {         // no ctx.db in here (compile-enforced)
//         GET("robots.txt") { ctx in .text(Discovery.robotsTxt(cfg), as: .text) }.cache(.discovery, etag: true)
//       }
//     }
//   }

public import ADServeCore
public import ADStorage
public import HTTPTypes

// MARK: - Pool (type-safe storage)

/// A route's pool. Its `Context` associated type decides the handler's context, so the
/// compiler forbids reaching `ctx.db` from a `.none` route.
public protocol PoolScope: Sendable {
  associatedtype Context: HandlerContext
  var needsStorage: Bool { get }
}

/// The central shared pool (shared process threads). The handler gets a DB context.
public struct SharedPool: PoolScope {
  public typealias Context = StorageContext
  public var needsStorage: Bool { true }
  public init() {}
}

/// No pool — a pure-config route. The handler gets a plain context (no `db`).
public struct NoPool: PoolScope {
  public typealias Context = RequestContext
  public var needsStorage: Bool { false }
  public init() {}
}

extension PoolScope where Self == SharedPool { public static var shared: SharedPool { SharedPool() } }
extension PoolScope where Self == NoPool { public static var none: NoPool { NoPool() } }

/// `ctx.db` — the pooled connection on a `.shared` route (alias for `connection`).
extension StorageContext {
  public var db: StorageConnection { connection }
}

// MARK: - The definition tree

/// A node in the definition tree — a leaf route or a path `Group`. Lowers to
/// `[CompiledRoute]` given an accumulated path prefix.
public struct RouteNode: Sendable {
  var cache: CachePolicy
  let make: @Sendable (_ prefix: String, _ cache: CachePolicy) -> [CompiledRoute]

  /// Set the route's cache policy (`Cache-Control` + ETag). No-op on a `Group`.
  public func cache(_ policy: CachePolicy) -> RouteNode {
    var copy = self
    copy.cache = policy
    return copy
  }
  public func cache(_ policy: CachePolicy, etag: Bool) -> RouteNode {
    var copy = self
    copy.cache = CachePolicy(cacheControl: policy.cacheControl, etag: etag)
    return copy
  }
  public var etag: RouteNode {
    var copy = self
    copy.cache.etag = true
    return copy
  }

  func build(prefix: String) -> [CompiledRoute] { make(prefix, cache) }
}

@resultBuilder
public enum RouteGroupBuilder {
  public static func buildExpression(_ node: RouteNode) -> [RouteNode] { [node] }
  /// Splice a pre-built list (lets a `@RouteGroupBuilder` helper compose into an `App` — e.g.
  /// share one route set across a loopback `App` and a TLS `App`).
  public static func buildExpression(_ nodes: [RouteNode]) -> [RouteNode] { nodes }
  public static func buildBlock(_ parts: [RouteNode]...) -> [RouteNode] { parts.flatMap { $0 } }
  public static func buildArray(_ parts: [[RouteNode]]) -> [RouteNode] { parts.flatMap { $0 } }
  public static func buildOptional(_ part: [RouteNode]?) -> [RouteNode] { part ?? [] }
  public static func buildEither(first: [RouteNode]) -> [RouteNode] { first }
  public static func buildEither(second: [RouteNode]) -> [RouteNode] { second }
}

/// A path-prefix group; composes its prefix into the children's paths. Nestable.
public func Group(_ prefix: String, @RouteGroupBuilder _ children: () -> [RouteNode]) -> RouteNode {
  let nodes = children()
  return RouteNode(cache: .unset) { parentPrefix, _ in
    let groupPrefix = joinPath(parentPrefix, prefix)
    return nodes.flatMap { $0.build(prefix: groupPrefix) }
  }
}

// MARK: - Routes (typed verbs + typed pool → typed context)

public func GET<P: PoolScope>(
  _ subpath: String, pool: P = SharedPool(),
  _ handler: @escaping @Sendable (P.Context) -> ResponseContent
) -> RouteNode {
  exactRoute(.get, subpath, pool: pool, handler)
}

public func POST<P: PoolScope>(
  _ subpath: String, pool: P = SharedPool(),
  _ handler: @escaping @Sendable (P.Context) -> ResponseContent
) -> RouteNode {
  exactRoute(.post, subpath, pool: pool, handler)
}

public func OPTIONS<P: PoolScope>(
  _ subpath: String, pool: P = NoPool(),
  _ handler: @escaping @Sendable (P.Context) -> ResponseContent
) -> RouteNode {
  exactRoute(.options, subpath, pool: pool, handler)
}

/// A typed pattern route — captures from a matcher closure (matched against the full
/// request path, so it is unaffected by the enclosing `Group` prefix).
public func GET<P: PoolScope, Captures: Sendable>(
  match: @escaping @Sendable (Substring) -> Captures?, pool: P = SharedPool(),
  _ handler: @escaping @Sendable (P.Context, Captures) -> ResponseContent
) -> RouteNode {
  let needsStorage = pool.needsStorage
  let bind: @Sendable (Substring) -> (@Sendable (HandlerInput) -> ResponseContent)? = { path in
    guard let captures = match(path) else { return nil }
    return { input in handler(P.Context(input), captures) }
  }
  return RouteNode(cache: .unset) { _, cache in
    [CompiledRoute(method: .get, needsStorage: needsStorage, cache: cache, exactPath: nil, bind: bind)]
  }
}

private func exactRoute<P: PoolScope>(
  _ method: HTTPRequest.Method, _ subpath: String, pool: P,
  _ handler: @escaping @Sendable (P.Context) -> ResponseContent
) -> RouteNode {
  let needsStorage = pool.needsStorage
  let run: @Sendable (HandlerInput) -> ResponseContent = { input in handler(P.Context(input)) }
  return RouteNode(cache: .unset) { prefix, cache in
    let full = joinPath(prefix, subpath)
    let bind: @Sendable (Substring) -> (@Sendable (HandlerInput) -> ResponseContent)? = {
      $0 == full[...] ? run : nil
    }
    return [CompiledRoute(method: method, needsStorage: needsStorage, cache: cache, exactPath: full, bind: bind)]
  }
}

// MARK: - App + Server

/// An app's pool config (the engine binds one app/port in the PoC). `.shared` = the central
/// pool on the shared process threads; `.concurrent` = an independent pool (future); `.none`
/// = no DB.
public enum PoolRef: Sendable { case shared, concurrent, none }

/// An application served on a port — the lowered form of an `App { … }`. A nil `port` binds
/// the process default; a nil `wire` inherits the `Server`'s default protocol. Both are
/// resolved by `Server(protocol:)` + `listeners(_:defaultPort:)`.
public struct Application: Sendable {
  public let port: Int?
  public let wire: Wire?
  let routes: [CompiledRoute]
}

/// An application served on a port. Omit `port` to bind the process default; give distinct
/// ports for multiple `App`s under one `Server` (e.g. a TLS listener + the loopback listener).
/// `protocol:` overrides the `Server`-level default `Wire` (HTTP version(s) × TLS).
public func App(
  port: Int? = nil, `protocol` wire: Wire? = nil, pool: PoolRef = .shared,
  @RouteGroupBuilder _ routes: () -> [RouteNode]
) -> Application {
  Application(port: port, wire: wire, routes: routes().flatMap { $0.build(prefix: "") })
}

@resultBuilder
public enum ServerBuilder {
  public static func buildExpression(_ app: Application) -> [Application] { [app] }
  public static func buildBlock(_ parts: [Application]...) -> [Application] { parts.flatMap { $0 } }
  public static func buildArray(_ parts: [[Application]]) -> [Application] { parts.flatMap { $0 } }
  public static func buildOptional(_ part: [Application]?) -> [Application] { part ?? [] }
  public static func buildEither(first: [Application]) -> [Application] { first }
  public static func buildEither(second: [Application]) -> [Application] { second }
}

/// The server definition → its applications (one NIO listener each). `protocol:` is the
/// default `Wire` applied to every `App` that didn't set its own. Lower to engine
/// `ListenerConfig`s with `listeners(_:defaultPort:)`.
public func Server(
  `protocol` wire: Wire = .http1, @ServerBuilder _ build: () -> [Application]
) -> [Application] {
  build().map { Application(port: $0.port, wire: $0.wire ?? wire, routes: $0.routes) }
}

/// Lower the `Server { … }` applications to engine `ListenerConfig`s: each `App` becomes one
/// listener (its own `port`/`wire`, else the defaults) over a `RouteTable` of its routes.
public func listeners(
  _ apps: [Application], defaultPort: Int, host: String = "127.0.0.1"
) -> [ListenerConfig] {
  apps.map {
    ListenerConfig(
      host: host, port: $0.port ?? defaultPort, wire: $0.wire ?? .http1,
      routes: RouteTable(routes: $0.routes))
  }
}

// MARK: - helpers

/// `joinPath("", "search") → "/search"`; `joinPath("/api", "filters") → "/api/filters"`.
private func joinPath(_ prefix: String, _ sub: String) -> String {
  let suffix = sub.hasPrefix("/") ? String(sub.dropFirst()) : sub
  return prefix + "/" + suffix
}
