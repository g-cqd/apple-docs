// ADServeDSL — the endpoint DSL (RFC 0005). Routes are declared with a result
// builder + SwiftUI-style modifiers; the handler context is a `@dynamicMemberLookup`
// value, and `.storage` flips the context type so a connection is only reachable when
// the route asked for one (compile-time enforced). The DSL sees only ADServeCore's
// public surface — it cannot touch engine internals.
//
// Surface: `GET("/path")` (exact) / `route(.get, match:)` (typed pattern matcher) →
// `.storage` / `.cache(…)` / `.respond { ctx[, captures] in … }` → a `Route`, all
// collected by `@RouteBuilder` into a `RouteTable` (an `HTTPHandling`). A declarative
// `Path { … }` capture builder + `Group` prefixing are a documented future addition;
// today's irregular routes (embedded hashes, rest-captures) are served by explicit
// typed matchers, which is honest and equally type-safe.

import ADServeCore
import ADStorage
import HTTPTypes
import Logging

// MARK: - Handler contexts

/// A handler context, buildable from the engine's per-request input.
public protocol HandlerContext: Sendable {
  init(_ input: HandlerInput)
}

/// The default context. `@dynamicMemberLookup` forwards `ctx.method`/`.path`/
/// `.target`/`.headers` to the underlying request.
@dynamicMemberLookup
public struct RequestContext: HandlerContext {
  public let request: ServerRequest
  public let logger: Logger
  public let requestID: String

  public init(_ input: HandlerInput) {
    request = input.request
    logger = input.logger
    requestID = input.requestID
  }

  public subscript<T>(dynamicMember keyPath: KeyPath<ServerRequest, T>) -> T {
    request[keyPath: keyPath]
  }
}

/// The context for `.storage` routes — `connection` is non-optional (the engine
/// checked one out). You cannot reach `connection` without `.storage`.
@dynamicMemberLookup
public struct StorageContext: HandlerContext {
  public let request: ServerRequest
  public let connection: StorageConnection
  public let logger: Logger
  public let requestID: String

  public init(_ input: HandlerInput) {
    request = input.request
    // Safe: the engine only builds a StorageContext for a `needsStorage` route, and
    // only after a successful checkout.
    connection = input.connection!
    logger = input.logger
    requestID = input.requestID
  }

  public subscript<T>(dynamicMember keyPath: KeyPath<ServerRequest, T>) -> T {
    request[keyPath: keyPath]
  }
}

// MARK: - Compiled route (engine-facing)

/// A fully-built route. `bind` returns a captures-applied handler when the path
/// matches, else nil; `exactPath` (when non-nil) lets the table index it O(1).
public struct CompiledRoute: Sendable {
  let method: HTTPRequest.Method
  let needsStorage: Bool
  let cache: CachePolicy
  let exactPath: String?
  let bind: @Sendable (Substring) -> (@Sendable (HandlerInput) -> ResponseContent)?
}

public protocol RouteConvertible {
  func compiledRoutes() -> [CompiledRoute]
}

/// A declared route (the terminal value `.respond` produces).
public struct Route: RouteConvertible {
  let compiled: CompiledRoute
  public func compiledRoutes() -> [CompiledRoute] { [compiled] }
}

// MARK: - Route stub + modifiers

/// A route under construction: method + matcher (+ captures type) + storage/cache.
/// Modifiers return a new stub; `.respond` finishes it into a `Route`.
public struct RouteStub<Ctx: HandlerContext, Captures: Sendable>: Sendable {
  var method: HTTPRequest.Method
  var exactPath: String?
  var matcher: @Sendable (Substring) -> Captures?
  var needsStorage: Bool
  var cache: CachePolicy

  /// Set the cache policy (`Cache-Control` + ETag).
  public func cache(_ policy: CachePolicy) -> Self {
    var copy = self
    copy.cache = policy
    return copy
  }

  /// Set the cache policy's `Cache-Control` and override its ETag flag.
  public func cache(_ policy: CachePolicy, etag: Bool) -> Self {
    var copy = self
    copy.cache = CachePolicy(cacheControl: policy.cacheControl, etag: etag)
    return copy
  }

  /// Attach a SHA-256-prefix ETag (304 on `If-None-Match`) with no `Cache-Control`.
  public var etag: Self {
    var copy = self
    copy.cache.etag = true
    return copy
  }
}

extension RouteStub where Ctx == RequestContext {
  /// Declare that this route needs a pooled connection on the offload executor; flips
  /// the handler context to `StorageContext` (non-optional `connection`).
  public var storage: RouteStub<StorageContext, Captures> {
    RouteStub<StorageContext, Captures>(
      method: method, exactPath: exactPath, matcher: matcher, needsStorage: true, cache: cache)
  }
}

extension RouteStub {
  /// Finish a pattern route, binding its typed captures into the handler.
  public func respond(_ body: @escaping @Sendable (Ctx, Captures) -> ResponseContent) -> Route {
    let matcher = self.matcher
    let bind: @Sendable (Substring) -> (@Sendable (HandlerInput) -> ResponseContent)? = { path in
      guard let captures = matcher(path) else { return nil }
      return { input in body(Ctx(input), captures) }
    }
    return Route(
      compiled: CompiledRoute(
        method: method, needsStorage: needsStorage, cache: cache, exactPath: exactPath, bind: bind))
  }
}

extension RouteStub where Captures == Void {
  /// Finish an exact (capture-free) route.
  public func respond(_ body: @escaping @Sendable (Ctx) -> ResponseContent) -> Route {
    respond { context, _ in body(context) }
  }
}

// MARK: - Route constructors

/// An exact-path GET route.
public func GET(_ path: String) -> RouteStub<RequestContext, Void> {
  RouteStub(
    method: .get, exactPath: path, matcher: { $0 == path[...] ? () : nil }, needsStorage: false,
    cache: .unset)
}

/// A pattern route whose typed captures come from a matcher closure. The matcher gets
/// the full request path and returns the captures on a match, else nil.
public func route<Captures: Sendable>(
  _ method: HTTPRequest.Method, match: @escaping @Sendable (Substring) -> Captures?
) -> RouteStub<RequestContext, Captures> {
  RouteStub(method: method, exactPath: nil, matcher: match, needsStorage: false, cache: .unset)
}

// MARK: - Result builder + table

@resultBuilder
public enum RouteBuilder {
  public static func buildExpression(_ route: some RouteConvertible) -> [CompiledRoute] {
    route.compiledRoutes()
  }
  public static func buildBlock(_ parts: [CompiledRoute]...) -> [CompiledRoute] { parts.flatMap { $0 } }
  public static func buildArray(_ parts: [[CompiledRoute]]) -> [CompiledRoute] { parts.flatMap { $0 } }
  public static func buildOptional(_ part: [CompiledRoute]?) -> [CompiledRoute] { part ?? [] }
  public static func buildEither(first: [CompiledRoute]) -> [CompiledRoute] { first }
  public static func buildEither(second: [CompiledRoute]) -> [CompiledRoute] { second }
}

/// The dispatch table the engine runs against (an `HTTPHandling`). Exact paths are
/// indexed O(1); pattern routes are tried in declaration order.
public struct RouteTable: HTTPHandling {
  private let exact: [String: [HTTPRequest.Method: CompiledRoute]]
  private let patterns: [CompiledRoute]

  public init(@RouteBuilder _ build: () -> [CompiledRoute]) {
    self.init(routes: build())
  }

  public init(routes: [CompiledRoute]) {
    var exact: [String: [HTTPRequest.Method: CompiledRoute]] = [:]
    var patterns: [CompiledRoute] = []
    for route in routes {
      if let path = route.exactPath {
        exact[path, default: [:]][route.method] = route
      } else {
        patterns.append(route)
      }
    }
    self.exact = exact
    self.patterns = patterns
  }

  public func match(method: HTTPRequest.Method, path: Substring) -> RouteMatch {
    var methodMismatch = false
    if let byMethod = exact[String(path)] {
      if let route = byMethod[method], let run = route.bind(path) {
        return .matched(MatchedRoute(needsStorage: route.needsStorage, cache: route.cache, run: run))
      }
      if !byMethod.isEmpty { methodMismatch = true }
    }
    for route in patterns {
      if let run = route.bind(path) {
        if route.method == method {
          return .matched(
            MatchedRoute(needsStorage: route.needsStorage, cache: route.cache, run: run))
        }
        methodMismatch = true
      }
    }
    return methodMismatch ? .methodNotAllowed : .notFound
  }
}
