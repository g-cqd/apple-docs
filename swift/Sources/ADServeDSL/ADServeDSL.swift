// ADServeDSL — the engine-facing route types + handler contexts (RFC 0005). The DSL
// SURFACE (`Server`/`App`/`Group`/`GET`…) lives in ServerDSL.swift; this file holds what the
// surface lowers TO: the `@dynamicMemberLookup` handler contexts (the connection is only
// reachable on a `.shared` (storage) context — compile-time enforced), the `CompiledRoute`
// the engine dispatches, and the `RouteTable` (`HTTPHandling`) it dispatches against. The
// DSL sees only ADServeCore's public surface — it cannot touch engine internals.

public import ADServeCore
public import ADStorage
public import HTTPTypes
public import Logging

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

/// The context for storage routes (`pool: .shared`) — `connection` is non-optional (the
/// engine checked one out). You cannot reach `connection` without a storage pool.
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

// MARK: - Dispatch table

/// The dispatch table the engine runs against (an `HTTPHandling`). Exact paths are
/// indexed O(1); pattern routes are tried in declaration order. The DSL surface lowers a
/// `Server { … }` to the `[CompiledRoute]` this is built from.
public struct RouteTable: HTTPHandling {
  private let exact: [String: [HTTPRequest.Method: CompiledRoute]]
  private let patterns: [CompiledRoute]

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
