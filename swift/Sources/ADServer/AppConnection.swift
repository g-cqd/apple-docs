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
// `StorageConnection`s, so the cast cannot fail. (The engine already force-*unwraps* the optional
// connection for a `needsStorage` route; this is the same invariant, one cast further.)
extension StorageContext {
    var db: StorageConnection { connection as! StorageConnection }
}
extension MCPToolContext {
    var db: StorageConnection { connection as! StorageConnection }
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
