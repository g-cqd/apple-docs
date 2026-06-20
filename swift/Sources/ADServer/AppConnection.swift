// The composition-root binding between the persistence-agnostic server engine and this app's
// concrete storage handle. ADServeCore/ADServeDSL pool and pass through `any PooledResource`; the
// app pins that erased resource to `StorageConnection` here, in one place.

public import ADConcurrency
import ADServeCore
import ADServeDSL
import ADStorage

// `StorageConnection` already exposes the failable `init?(path:)` that `PooledResource` requires, so
// the conformance is empty. Same package as the app target, so no `@retroactive`.
extension StorageConnection: PooledResource {}

// `ctx.db` / `context.db` — down-cast the engine's type-erased `any PooledResource` to the app's
// concrete connection. Safe by construction: a `.shared` (or MCP) route's pool holds exactly
// `StorageConnection`s (built via `AnyConnectionPool.storage(...)` / the stdio
// `MCPToolContext(connection:)` below), so the cast cannot fail. (The engine already
// force-*unwraps* the optional connection for a `needsStorage` route; this is the same invariant,
// one cast further.)
//
// The down-cast is a guarded `as?` rather than a bare `as!`: the invariant holds, but if a future
// composition wired a different resource type into the pool, the bare cast would trap with an
// opaque "Could not cast value of type …" message. `requireStorageConnection` instead traps with a
// diagnostic that NAMES the broken invariant and the actual runtime type — far easier to localize.
// Every call site needs the concrete connection synchronously, so a non-trapping fallback isn't
// expressible here (there is no zero-arg `StorageConnection`); this keeps the `db: StorageConnection`
// signature and all call sites unchanged while replacing a silent trap with a documented one.
private func requireStorageConnection(
    _ connection: any PooledResource, file: StaticString = #fileID, line: UInt = #line
) -> StorageConnection {
    guard let storage = connection as? StorageConnection else {
        preconditionFailure(
            """
            ad-server invariant violated: a `.shared`/MCP route's pool must hold \
            StorageConnection, but ctx.connection was \(type(of: connection)). \
            Check the pool wiring at the composition root (AnyConnectionPool.storage).
            """,
            file: file, line: line)
    }
    return storage
}

extension StorageContext {
    var db: StorageConnection { requireStorageConnection(connection) }
}
extension MCPToolContext {
    var db: StorageConnection { requireStorageConnection(connection) }
}

extension AnyConnectionPool {
    /// Build the engine's type-erased pool from a concrete `ResourcePool<StorageConnection>`. The
    /// closure brackets a `ResourcePool` lease (checkout → run → checkin on scope exit) around the
    /// handler, so the noncopyable lease's auto-return is preserved across the erased boundary.
    /// `nil` if the database cannot be opened (libsqlite3/FTS5 unavailable).
    static func storage(path: String, count: Int) -> AnyConnectionPool? {
        guard let pool = ResourcePool<StorageConnection>(path: path, count: count) else { return nil }
        return AnyConnectionPool { body in
            guard let lease = pool.lease() else { return nil }
            return body(lease.resource)
        }
    }
}
