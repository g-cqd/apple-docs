# RFC 0005 — a type-safe Swift server framework + the native MCP protocol

- **Status: In progress** (opened 2026-06-14). Carries the remaining **RFC 0001
  P6** server scope — the **MCP protocol** (kills `@modelcontextprotocol/sdk` +
  `zod`) — and a new cross-cutting concern: an **in-house, type-safe server DSL**
  that decouples the engine, the endpoint definitions, and the business logic.
- Parent: [RFC 0001 §7 P6](0001-swift-native-transition.md). The P6 **web slice**
  (the 13 `/api/*`+`/data/*`+discovery routes + `/search`) is **DONE** and
  archived in [p6/records.md](0001-swift-native-transition/p6/records.md); this RFC
  refactors that surface onto the DSL and adds MCP.
- Sibling: [RFC 0006 — codebase health & conformance](0006-codebase-health.md).
  The framework here is where 0006's safe-type doctrine is adopted first.
- **Detailed execution + decision records**: [`records.md`](0005-server-framework/records.md).
- Repo-internal: like all of `rfcs/`, never built or indexed by the docs site.

## 1. Why

`ad-server` works and is parity-clean, but the serving code is **hard to read**.
`Serving.swift` is one ~240-line `switch` where every arm re-threads the same
pool-checkout / `defer` / `threadPool.runIfActive` / response-wrap boilerplate;
`WebRoutes.swift` welds routing + SQL + JSON serialization together;
`WebResponse.swift` hand-rolls header tuples, hex, and a v4 UUID. Adding a route
means editing a monolith. The three concerns the operator wants apart —

- the **server engine** (the thing we optimize: NIO, framing, offload, the
  response envelope, the MCP transports),
- the **definition of endpoints** (path → typed input → response + cache policy),
- the **business logic** (the SQL/cascade/render that answers a request),

— are fused. This RFC introduces a small, original Swift DSL (result builders +
a URLBuilder-style typed `Path` + RegexBuilder captures + `@dynamicMemberLookup`
context + SwiftUI-style modifiers) so endpoints are declared *declaratively and
checked at compile time*, the engine is an independently optimizable library, and
business logic is pure functions the endpoints call. The same engine then carries
the **native MCP protocol**, retiring the last two MCP npm deps.

## 2. The three layers (compiler-enforced)

| Layer | Module | Owns | Knows about |
| --- | --- | --- | --- |
| Engine | **`ADServeCore`** (new lib) | NIO bootstrap; HTTP/1.1 on swift-http-types; the response envelope (security set + `Link` + `Vary` + `X-Request-Id` + `hashable`→ETag→304); the `.storage` offload + pool; swift-log; the MCP JSON-RPC core + stdio/HTTP transports | nothing route-specific |
| Endpoints | **`ADServeDSL`** (new lib) | `@RouteBuilder`, `Route`/`Group`, the typed `Path`, `RequestContext`, `RouteQuery`, `ResponseContent`; later the `Tool` DSL + `@ToolInput` macro | ADServeCore protocols |
| Logic | **`ADServer` exe + `Services`** | the endpoint *declarations*; Services over `ADSearchCascade`/`ADStorage`/`ADContent`/`ADRender` | the DSL + the domain |

A route declaration is the only thing that changes when an endpoint is added; it
cannot reach into engine internals (different module, no `@testable`).

## 3. The DSL (the shape)

HTTP route DSL (Phase B — the headline; D-0005-1 sequences it before MCP):

```swift
@RouteBuilder
func endpoints() -> some RouteCollection {
  GET("/healthz").cache(.noStore)
    .respond { _ in .json(Health(ok: true, service: "ad-server")) }

  GET("/search").query(SearchParams.self).storage.cache(.passthrough)
    .respond { ctx in .json(rawBytes: Cascade.search(ctx.connection, ctx.query)) }

  Group("/api") {
    GET("/filters").storage.cache(.apiCorpus)
      .respond { ctx in .json(rawBytes: WebRoutes.filters(ctx.connection)) }

    // typed path captures (RegexBuilder under the hood) — compile-checked:
    Route(.GET, Path { "symbols/"; Capture(SymbolScope.self); "/"; Capture(.untilDotJSON) })
      .storage.cache(.apiCorpus, etag: true)
      .respond { ctx in
        WebRoutes.symbolMetadata(ctx.connection, scope: ctx.path.0, name: ctx.path.1)
          .map(ResponseContent.json(rawBytes:)) ?? .notFound
      }
  }
}
```

What the DSL buys (the boilerplate it deletes):
- **`.storage`** declares "needs a pooled connection on the offload executor"; the
  engine does the checkout / `defer` checkin / `runIfActive` once and injects
  `ctx.connection`. Pure-config routes (discovery, healthz) run on the event loop.
- **The envelope is automatic.** The engine applies the security set + `Link` +
  `Vary` + `X-Request-Id` to every response; routes only opt into `.cache(…)` /
  `etag:`. No route touches a header.
- **`ctx`** is a `@dynamicMemberLookup RequestContext`: `.query` (typed via
  `RouteQuery`), `.path` (typed RegexBuilder captures), `.connection`, `.config`,
  `.logger`, `.requestID`.
- **`ResponseContent`**: `.json(Encodable)` (ADJSON) / `.json(rawBytes:)` /
  `.json(JSONValue)` / `.text` / `.bytes` / `.notFound` / `.status`.
- Static paths match by exact-map (fast); only `Path { … }` routes pay regex.

Bootstrap becomes declarative (engine owns NIO; flags still parse into a value):

```swift
@main struct AdServer: ServerApp {
  var body: some ServerComponent {
    Listen(host: "127.0.0.1", port: config.port)
    UseStorage(path: config.db, poolSize: config.threads)
    UseLogger(label: "ad-server")
    HTTP { endpoints() }
    // MCP { tools() }   // Phase C+
  }
}
```

## 4. MCP (Phases C–D; D-0005-4)

- **Protocol in-house.** `ADServeCore` carries JSON-RPC 2.0 (`Codable` request/
  response/error on ADJSON) + a dispatcher + `initialize` / `ping` / `tools/list`
  / `tools/call` / `resources/list` / `resources/read`. ProtocolVersion negotiated,
  default `2024-11-05` (matches the current SDK), up to `2025-06-18`.
- **Transports: both, stdio-first.** stdio (newline-delimited JSON-RPC over
  stdin/stdout — the primary local-client path, Claude Desktop/CLI via the bin)
  first; then **Streamable HTTP** `POST /mcp` (stateless) mounted as a route on the
  *same* HTTP engine.
- **Tool DSL + the zod-killer.** `Tool("search_docs", "…").input(SearchDocsInput.self)
  .respond { … }`, where `SearchDocsInput` is a `Codable` struct and a **`@ToolInput`**
  macro (swift-syntax, already in-tree via ADJSON) synthesizes its JSON Schema from
  stored properties + doc-comments + constraint wrappers — replacing zod's
  `.int().min().max().describe()`. `tools/list` serves the derived schema; `tools/call`
  decodes the struct. Fallback if the macro slips: a hand-written `static var jsonSchema`.
- **Result shaping**: `{content:[{type:text,text}], structuredContent}` + image
  content (SVG / PNG base64) for render tools + `isError`. The **projection +
  pagination** business logic (`src/output/projection.js`, `src/mcp/pagination.js`)
  and the per-tool command orchestration (`src/commands/*`) port into Swift
  `Services` — that is the bulk of MCP work; the protocol itself is small.
- **Tool availability is gated by native Services.** Phase C ships the
  already-native tools (search_docs via Cascade; list_taxonomy/list_frameworks/
  browse + symbols/fonts via ADStorage); Phase D adds read_doc (lookup + markdown
  via ADContent+ADStorage) + the render tools (ADRender) + the 4 resources.

## 5. Decisions

| ID | Question | Decision |
| --- | --- | --- |
| D-0005-1 | DSL shape: unified HTTP+MCP "capability", two sibling DSLs, or HTTP-first | **HTTP route DSL first** (operator), MCP `Tool` DSL second; both over the same engine + shared Services. The unified single-declaration "capability" is a later option, not built now |
| D-0005-2 | How endpoints are declared | **Result builders + SwiftUI-style modifiers + a URLBuilder-style typed `Path`** (RegexBuilder typed captures); `@dynamicMemberLookup RequestContext`; everything compile-checked. Engine/DSL/logic are **three modules** (the decoupling is enforced by the compiler, not convention) |
| D-0005-3 | Type vocabulary | **Adopt the safe types from day one** (RFC 0006): swift-http-types headers/status, swift-log, typed `throws` + rich error enums, `Tagged`/domain enums for params, `Foundation.URL`, `UUID`. New code sets the bar; existing modules are a scheduled backlog |
| D-0005-4 | MCP protocol + schema | **In-house JSON-RPC 2.0**, transports **both (stdio-first)**, tool schemas via a **`@ToolInput` macro** + `Codable` (no zod). *Kills* `@modelcontextprotocol/sdk` + `zod` |
| D-0005-5 | Parity discipline | The route refactor is **behavior-preserving**: the web-routes (19) + search-cascade (34) parity suites are the invariant, re-run after every port. MCP adds an **intrinsic contract test** (deep-equal `tools/call` results + `tools/list` schemas vs the JS MCP) |
| D-0005-6 | Build scope | **Full build, phased A–E** (operator), each phase independently committable behind the gates; `ad-server` stays **inert to production** until the operator enables the flip |

## 6. Phases (each independently committable + gated)

- **A — RFCs + scaffolding** (this commit): the two RFCs, the dashboard
  restructure, the P6-web archive note; the empty `ADServeCore`/`ADServeDSL`
  targets + deps; `swift build` green.
- **B — HTTP engine + route DSL + port (the core):** build the engine + DSL; port
  *all* existing routes; delete the `Serving.swift` switch and fold
  `WebResponse`/`WebRoutes` plumbing into engine+DSL. **Invariant: 19 + 34 parity
  green; no `/search` perf regression.**
- **C — MCP core + stdio + native-backed tools:** JSON-RPC + stdio +
  `tools/list`/`tools/call`; the `Tool` DSL + `@ToolInput` (`ADServeMacros`);
  Services for the already-native tools. **Gate: `mcp-parity` contract test.**
- **D — read_doc + render tools + Streamable HTTP + resources:** the remaining
  Services + the 4 resources; mount `POST /mcp`. **Gate: full 9-tool + 4-resource
  parity over stdio AND HTTP.**
- **E — health conformance + flip readiness:** apply the existing-module fixes the
  framework unlocks (RFC 0006), carry the operator-gated Caddy/launchd flip docs.

## 7. Packaging

New targets in `swift/Package.swift`: `ADServeCore`, `ADServeDSL` (+ `ADServeMacros`
in Phase C). New dependencies (all §2-compliant): `apple/swift-http-types`,
`apple/swift-log`, `apple/swift-nio-extras` (the NIO↔HTTPTypes bridge),
`pointfreeco/swift-tagged`; swift-syntax is already present transitively (ADJSON).
The `libAppleDocsCore` dylib stays zero-external-dep — these are `ad-server`-only.

## 8. Gates

| Gate | Bar |
| --- | --- |
| Route refactor (Phase B) | web-routes parity 19/19 + search-cascade 34/34 unchanged; deterministic headers match; `p6-sweep.mjs` no regression |
| MCP contract (Phase C–D) | `tools/call` results intrinsic-identical to the JS MCP; `tools/list` schemas semantically equal; over stdio AND HTTP |
| Concurrency | max strict concurrency; no `@unchecked` beyond the contained `StorageConnection`; TSan-clean |
| Dependency policy | apple/* + swiftlang/* + pointfreeco/* only (§2); `Package.resolved` committed |

## 9. Outcome

*To be filled as phases A–E land — see [`records.md`](0005-server-framework/records.md).*

---
*Maintenance*: update this contract's Status + §9 as phases land; dated execution
detail belongs in [`records.md`](0005-server-framework/records.md).
