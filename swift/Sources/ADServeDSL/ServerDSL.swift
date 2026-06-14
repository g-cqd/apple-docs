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
//     Listen(pool: .shared) {                    // the central shared pool
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

import ADServeCore
import ADStorage
import HTTPTypes

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

// MARK: - Listener + Server

/// A listener's pool config (the engine binds one listener in the PoC). `.shared` = the
/// central pool on the shared process threads; `.concurrent` = an independent pool (future);
/// `.none` = no DB.
public enum PoolRef: Sendable { case shared, concurrent, none }

public struct Listener: Sendable {
  let routes: [CompiledRoute]
}

/// A listener. `port:` is accepted for the future multi-listener engine; the PoC binds the
/// one port from the server configuration.
public func Listen(
  port: Int? = nil, pool: PoolRef = .shared, @RouteGroupBuilder _ routes: () -> [RouteNode]
) -> Listener {
  Listener(routes: routes().flatMap { $0.build(prefix: "") })
}

@resultBuilder
public enum ServerBuilder {
  public static func buildExpression(_ listener: Listener) -> [Listener] { [listener] }
  public static func buildBlock(_ parts: [Listener]...) -> [Listener] { parts.flatMap { $0 } }
  public static func buildArray(_ parts: [[Listener]]) -> [Listener] { parts.flatMap { $0 } }
}

/// The server definition → the lowered routes. PoC: the listeners' routes merge (one bound
/// port). Returning `[CompiledRoute]` lets the PoC concatenate new-DSL routes with the
/// remaining current-DSL ones; the multi-listener `Server → engine` form is a later step.
public func Server(@ServerBuilder _ build: () -> [Listener]) -> [CompiledRoute] {
  build().flatMap(\.routes)
}

/// The current (flat) DSL lowered to `[CompiledRoute]` — so the PoC can `+`-merge it with
/// the new `Server { … }` routes into one `RouteTable`.
public func routes(@RouteBuilder _ build: () -> [CompiledRoute]) -> [CompiledRoute] {
  build()
}

// MARK: - helpers

/// `joinPath("", "search") → "/search"`; `joinPath("/api", "filters") → "/api/filters"`.
private func joinPath(_ prefix: String, _ sub: String) -> String {
  let suffix = sub.hasPrefix("/") ? String(sub.dropFirst()) : sub
  return prefix + "/" + suffix
}
