# ``ADServeDSL``

A hierarchical, type-safe DSL for declaring the `ad-server` route surface and its
MCP tools, decoupled from the ``ADServeCore`` engine and the handler bodies.

## Overview

A server definition reads as a tree and lowers to the engine's route table:

```swift
Server {
  App(pool: .shared) {
    GET("search") { ctx in .json(Cascade.search(ctx.db, …), as: .jsonRaw) }
    Group("api") {
      GET("filters") { ctx in .json(WebRoutes.filters(ctx.db), as: .json) }.cache(.apiCorpus)
    }
    POST("mcp") { ctx in handleMCPPost(ctx, dispatcher: dispatcher) }.cache(.noStore)
  }
}
```

The pool is a typed parameter that picks the handler's context, so a pure-config
route (`.none`) cannot reach `ctx.db` — the compiler enforces it. Verbs, cache
policy, and output ``MediaType`` are all typed; the cross-cutting envelope is
applied by the engine.

## Topics

### Server & application

- ``Server(protocol:_:)``
- ``App(port:protocol:pool:_:)``
- ``Application``
- ``listeners(_:defaultPort:host:)``

### Routes & groups

- ``GET(_:pool:_:)``
- ``POST(_:pool:_:)``
- ``OPTIONS(_:pool:_:)``
- ``Group(_:_:)``
- ``RouteNode``
- ``RouteTable``

### Pools

- ``PoolScope``
- ``SharedPool``
- ``NoPool``
