# RFC 0005 — server framework + MCP: execution + decision records

Parent contract: [`../0005-server-framework.md`](../0005-server-framework.md).
Repo documentation; never built or indexed by the docs site. Sequential records —
once written, a record does not change (audit trail).

## Design baseline (the thing being refactored)

The P6 web slice ([p6/records.md](../0001-swift-native-transition/p6/records.md),
"Seventh slice") shipped 13 routes + `/search` with the dispatch as a `switch` in
`ADServer/Serving.swift` and the cross-cutting envelope in `ADServer/WebResponse.swift`.
Behavior is parity-clean (19 web + 34 search cases) and stays the contract; this
RFC changes *structure only* in Phase B. The pre-DSL files
(`Serving`/`WebResponse`/`WebRoutes`/`WebModels`/`SiteConfig`/`QueryParse`.swift)
dissolve into the engine (`ADServeCore`) + the DSL (`ADServeDSL`) + thin route
declarations + `Services`.

## Decision records

### D-0005-1 — HTTP route DSL first; MCP tool DSL second (operator, 2026-06-14)
The AskUserQuestion fork offered (a) a unified single-declaration "capability"
surfaced on both HTTP and MCP, (b) two sibling DSLs over one engine, (c) HTTP route
DSL first. Operator chose **(c)**. So Phase B builds the HTTP route DSL and ports the
existing routes; the MCP `Tool` DSL (Phase C) is a sibling sharing the engine +
`Services`. The unified "capability" (define once, surface twice) remains a possible
later consolidation — recorded, not built.

### D-0005-2 — three modules, compiler-enforced decoupling
Engine = `ADServeCore`, endpoints = `ADServeDSL`, logic = `ADServer` exe + `Services`.
Separate modules (not folders) so a route declaration *cannot* reach into engine
internals. The DSL vocabulary: a `@RouteBuilder` result builder; `Route`/`Group`;
a URLBuilder-style `Path { … }` with **RegexBuilder typed captures** (`ctx.path.0`
is the captured type, count + types compile-checked); SwiftUI-style modifiers
(`.query`, `.storage`, `.cache`, `.respond`); a `@dynamicMemberLookup RequestContext`;
a `ResponseContent` enum encoded via **ADJSON**. The engine applies the constant
envelope (security set + `Link` + `Vary` + `X-Request-Id` + `hashable`→ETag→304) to
every response; `.storage` centralizes the pool-checkout + offload that every DB
route hand-rolled.

### D-0005-3 — adopt the safe types from day one (cross-ref RFC 0006)
The new framework is greenfield, so it adopts the safe-type vocabulary 0006
prescribes: swift-http-types (`HTTPField`/`HTTPFields`/`HTTPResponse.Status`) for all
headers/status; swift-log for logging; typed `throws` + rich error enums; `Tagged`/
domain enums for params (`SymbolScope`, framework slug, doc key); `Foundation.URL`/
`URLComponents` for base-url handling; `UUID` for the request-id mint. Existing
modules are 0006's scheduled backlog, not forced here.

### D-0005-4 — MCP in-house; both transports, stdio-first; `@ToolInput` kills zod
JSON-RPC 2.0 (`Codable` on ADJSON) + a dispatcher in `ADServeCore`; transports stdio
(primary, newline-delimited) then Streamable HTTP `POST /mcp` (stateless) on the same
engine. Tool input schemas come from a swift-syntax **`@ToolInput`** macro over
`Codable` structs (synthesizes JSON Schema from properties + doc-comments + constraint
wrappers), replacing `zod`. ProtocolVersion negotiated (default `2024-11-05`). *Kills*
`@modelcontextprotocol/sdk` + `zod`. Fallback if the macro slips: hand-written
`static var jsonSchema` per input struct (DSL shape unchanged).

### D-0005-5 — parity is the invariant, not a goal to re-prove
Phase B is behavior-preserving: `test/unit/native/web-routes-parity.test.js` (19) +
the search-cascade parity (34) are re-run after every route port; the deterministic
headers must still match (watch swift-http-types name canonicalization — emit the
lowercase names the test asserts). MCP adds `test/unit/native/mcp-parity.test.js`
(intrinsic deep-equal `tools/call` results + semantic `tools/list` schema equality vs
the JS MCP, over stdio AND HTTP).

### D-0005-6 — full build, phased, inert until the operator flips
Operator chose the full build (vs docs-only / PoC). Phases A–E each commit behind the
gates; `ad-server` stays inert to production (not wired into cli.js/ops/Caddy) until
the operator enables the Phase-E flip.

## Verified dependency coordinates (docs-researcher, 2026-06-14)

All confirmed against each repo's pinned `Package.swift`/sources (not memory):

| Dependency | Version | Product(s) | Import |
| --- | --- | --- | --- |
| `apple/swift-http-types` | from `1.6.0` | `HTTPTypes` | `HTTPField`/`HTTPFields`/`HTTPField.Name`/`HTTPRequest`/`HTTPResponse`/`HTTPResponse.Status` |
| `apple/swift-log` | from `1.13.2` | `Logging` | `Logger` |
| `apple/swift-nio-extras` | from `1.34.1` | `NIOHTTPTypes`, `NIOHTTPTypesHTTP1` | the NIO↔HTTPTypes bridge |
| `pointfreeco/swift-tagged` | from `0.10.0` | `Tagged` | (pre-1.0 — API technically unstable) |

**Bridge wiring** (Phase B): add **`HTTP1ToHTTPServerCodec(secure: false)`** to the
server pipeline *after* `configureHTTPServerPipeline()`; it converts NIO's
`HTTPServerRequestPart`/`…ResponsePart` ↔ the HTTPTypes-backed `HTTPRequestPart`/
`HTTPResponsePart`. The `NIOAsyncChannel` then wraps
`<HTTPRequestPart, HTTPResponsePart>` (not the NIO part types). `secure:` sets the
`:scheme` pseudo-header per TLS.

**Caveat — swift-nio floor bump.** swift-nio-extras 1.34.1 requires swift-nio
`from: 2.94.0`; the package currently pins `from: 2.65.0`, so adding nio-extras moves
swift-nio's resolved version up (apple/*, in-policy) — a `Package.resolved` change to
note at scaffolding.

## Records

### Record A — RFCs + scaffolding — DONE (2026-06-14)
This RFC + RFC 0006 written; the dashboard restructured (P6 web/search → DONE; MCP +
framework → 0005; health → 0006); RFC 0001 §P6 + maintenance log updated; the P6-web
archive/closeout note added. Empty `ADServeCore`/`ADServeDSL` targets scaffolded + the
four verified deps wired (swift-http-types 1.6, swift-log 1.13.2, swift-nio-extras
1.34.1 — which pulls swift-nio up to ≥ 2.94, swift-tagged 0.10). **`swift build` green**
(debug + release); the existing parity suites are **unregressed by the swift-nio bump:
53/53** (19 web-routes + 34 search-cascade). No serving logic changed — the engine + DSL
land in Phase B.

### Records B–E — to be filled as the phases execute.
