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

### Record B — HTTP engine + route DSL + port — DONE (2026-06-14)

The whole HTTP surface moved off the `Serving.swift` switch onto the DSL, behind the
existing parity gates.

**Engine (`ADServeCore`):** `HTTPServer` (NIO bootstrap + the structured accept loop +
the per-connection serve loop, lifted from `Main`/`Serving`); the response envelope
(`write` — ETag-once → 304, content-type/length, cache-control, the constant header
set, request-id, connection); `ServerRequest`/`ResponseContent`/`CachePolicy`/
`HandlerInput`/`MatchedRoute`/`HTTPHandling` value types; the moved `ConnectionPool`;
and the engine-generic helpers `sha256HexLower`/`matchesIfNoneMatch`/`resolveRequestID`.

**DSL (`ADServeDSL`):** `@RouteBuilder` → `RouteTable` (exact O(1) index + ordered
patterns, conforms `HTTPHandling`); `GET(_:)` + `route(_:match:)`; the `.storage` /
`.cache` / `.cache(_:etag:)` / `.etag` / `.respond` modifiers; `RequestContext` +
`StorageContext` (both `@dynamicMemberLookup`, the latter with a non-optional
`connection` so you can't reach a connection without `.storage`).

**App (`ADServer`):** `Endpoints.swift` declares all 18 routes (the headline — the
whole surface is now declarative) + builds the envelope as `HTTPFields` + the
`apiCorpus`/`discovery` cache presets; `Main.swift` slimmed to flag-parse → config →
`HTTPServer.run()` (+ the `--bench` diagnostic). `WebRoutes.readyz` now returns a
`ResponseContent`; `searchManifest` uses the engine's `sha256HexLower`. **Deleted**:
`Serving.swift`, `WebResponse.swift`, `ConnectionPool.swift` (the app copy).

**Decisions taken during the build (D-0005-7..9):**
- **D-0005-7 — full HTTPTypes serving path.** Adopted the `NIOHTTPTypesHTTP1`
  `HTTP1ToHTTPServerCodec` bridge so the engine speaks `HTTPRequest`/`HTTPResponse`/
  `HTTPFields` end-to-end (`NIOAsyncChannel<HTTPRequestPart, HTTPResponsePart>`). The
  current server already emitted lowercase header names (== HTTPTypes canonical), and
  the parity test compares header *values* (fetch normalizes names) — so the wire
  behavior is unchanged. The swift-nio floor moved to ≥ 2.94 (nio-extras 1.34.1).
- **D-0005-8 — explicit typed matchers over a `Path { }` builder (for now).** The three
  pattern routes have irregular grammar (embedded 10-hex hashes, rest-until-`.json`,
  percent-decoded names) that a segment/capture builder fits poorly; the proven
  matchers (`matchSymbolMetadataPath` etc.) are reused as typed `@Sendable (Substring)
  -> Captures?` closures — equally type-safe, no premature abstraction. The declarative
  `Path { Capture(…) }` builder + `Group` prefixing + a `.query(T)` decoder + a
  `ServerApp` config builder are **recorded as future ergonomics**, unbuilt (YAGNI).
- **D-0005-9 — synchronous handlers.** Route `run` is sync (all business logic is sync),
  so the `.storage` offload stays the proven `threadPool.runIfActive { checkout; defer
  checkin; run }` shape. An async variant can be added when a route needs it.

**Per-route fidelity preserved exactly:** `/search` keeps `application/json` (no charset)
+ no cache; `/api/*` JSON keeps `application/json;charset=utf-8`; the framework-tree keeps
`application/json; charset=utf-8` (with space) + immutable + no ETag; the two 404 bodies
stay distinct (`Not Found` for a route-level miss via `.notFound`, `not found\n` for an
unmatched path). `UUID().uuidString.lowercased()` satisfies the lowercase-v4 request-id
regex.

**Gates (all green):** web-routes parity **19/19** + search-cascade **34/34** (intrinsic
JSON + deterministic headers), full native suite **99/99**, `swift test` clean. Perf
sweep (480-doc synthetic, `ab -k`, q=view&limit=100): SwiftNIO rps 244 / 905 / 972 / 718
at c=1/4/8/16 vs Bun 364 / 734 / 735 / 670 — scales positively, ad-server ≥ Bun at c≥4;
the c=1 gap is the known per-request offload overhead, not a refactor regression.

### Record C — MCP core + stdio + the first 4 native tools — first cut DONE (2026-06-14)

The native MCP server stands up; the SDK + zod are gone for the implemented tools.

**Core (`ADServeCore/MCP.swift`):** in-house JSON-RPC 2.0 built on ADJSON `JSONValue`
(parse a line → dispatch → encode a line). `MCPDispatcher` handles `initialize`
(echoes the client's `protocolVersion` if supported else `2025-11-25`; capabilities
`{resources,tools: {listChanged:true}}`; serverInfo + instructions), `ping` (`{}`),
`tools/list`, `tools/call` (`{content:[{type:text,text}], structuredContent}` on success;
`{content,isError:true}` on failure), `notifications/initialized` (no response), and
`-32601` for unknown methods — the exact SDK wire shapes (mapped from
`node_modules/@modelcontextprotocol/sdk` + an in-memory drive). `StdioMCPTransport` is a
synchronous `readLine` loop (newline-delimited JSON; logs forced to STDERR so STDOUT
carries only JSON-RPC). The tool surface is an `MCPToolProviding` (engine ⇄ DSL seam).

**Tool DSL (`ADServeDSL/Tool.swift`):** `Tool("name","desc").input(SomeInput.self)
.respond { input, ctx in … }` → `@ToolBuilder` → `ToolRegistry` (declaration order for
tools/list, O(1) by-name for tools/call). Mirrors the route DSL.

**Tools + Services (`ADServer/Tools.swift`):** list_taxonomy + list_frameworks (new
ADStorage queries `taxonomyCounts`/`listFrameworkRoots`), search_sf_symbols +
list_apple_fonts (reuse the existing `searchSfSymbols`/`WebRoutes.fonts`). Each handler
projects to the exact `project*()` shape (the lean `projectSearchSfSymbols`
`{results:[{name,scope}]}`, `projectTaxonomy`, `projectFrameworks`,
`projectListAppleFonts`). `ad-server mcp --db … --app-version …` runs the stdio server.

### D-0005-10 — tool schemas via ADJSON `@Schemable` (operator, 2026-06-14)
The Tool DSL initially carried a hand-rolled `Schema.*` JSON-Schema builder (and the RFC
had planned a bespoke `@ToolInput` macro). The operator redirected: **use ADJSON's
existing `@Schemable` macro directly on `Decodable` input structs** — it derives the
schema AND gives typed decoding, so the builder + the bespoke macro are both dropped.
`.input(T.self)` reads `T.__adjsonSchemaText`; `.respond` receives the decoded `T`.

**Caveat — `@Schemable` is structural today.** It emits `{type,properties,required,items,
additionalProperties}` (no `$schema`, descriptions, enums, or numeric bounds), so the
`tools/list` schema is leaner than the SDK's zod (draft-07, rich) schema. So the
**mcp-parity gate is the tools/call behavior + the tool metadata** (name/description/
annotations/execution) + a structurally-coherent inputSchema — NOT the schema text. A
schema-requirements spec was written and forwarded to the ADJSON team (R1 doc-comment
descriptions, R2 enum-from-Swift-enum, R3 numeric bounds, R5 draft-07 `$schema`, R8 a
public schema accessor, R11 nested-field descriptions); when those land the schemas
enrich toward byte-parity with zod, no DSL change.

### Gate
New `test/unit/native/mcp-parity.test.js` boots `ad-server mcp` over stdio and drives the
JSON-RPC: initialize (protocolVersion/serverInfo/capabilities/instructions), ping,
tools/list (the 4 tools' metadata + structural schema), tools/call (each result's
`structuredContent` + `content[0].text` deep-equal the JS command+projection), unknown
method → -32601. **9/9**; full native suite **108/108** (the HTTP path unregressed);
`swift test` clean. Arg-schema *validation* (the SDK's zod rejection of bad args) is
deferred — `Decodable` decoding already enforces types + required; enum/bounds rejection
lands with the richer schema.

**search_docs added (2026-06-14).** The cascade-backed tool reuses `Cascade.search` bytes
directly: the Swift cascade already projects with **`webPaths:false`** (the MCP variant — the
web `/search` route uses `webPaths:true`), and `search()`'s defaults (`fuzzy !== false` → on,
`noDeep` → off) match the cascade's always-on behavior, so the bytes ARE
`projectSearchResult(search(…), {webPaths:false})`. The only glue is the MCP param mapping
(limit default 25, `minVersion.{ios…}` → `minIos…`). `read=true` / `maxChars` / `match`
(inline + pagination + excerpts) ride Phase D and are **omitted from the schema** (nothing
advertised-but-unimplemented). mcp-parity **10/10**, full native **109/109**. Left in Phase C:
**browse**.

**Schema enrichment landed (2026-06-14).** The ADJSON team shipped the rich-schema API
(`57cc659`) co-designed in the sign-off thread: `@Schemable(dialect: .draft7)` +
`@SchemaInfo` / `@SchemaNumber(range)` + Swift `CaseIterable` enums + the public
`jsonSchemaText` accessor + both edge cases (E1 field-less → `properties:{}`, E2
`SchemaNumber(type: .number)` for `search_docs.year`). The input structs were enriched and
the DSL flipped from the `__adjsonSchemaText` SPI to `jsonSchemaText`; the mcp-parity
`tools/list` test now **deep-equals each tool's inputSchema against the exact zod draft-07
schema** — **10/10**, full native **109/109**. The D-0005-10 structural caveat is
**RESOLVED**: `tools/list` is byte-for-byte (intrinsic) zod-equal, with no zod, no
hand-rolled builder, and no bespoke macro.

**browse added — Phase C tool set complete (2026-06-14).** The most involved cheap tool:
new ADStorage `Browse.swift` queries (`resolveRoot` exact→fuzzy, `pagesByRoot`,
`browsePage` [document→active-page fallback], `documentChildren`) + the full browse.js
branch logic ported (path→children; bare WWDC→per-year `groups`; WWDC+year→filtered pages;
flat pages with the MCP `defaultLimit:100`), projected to the exact `projectBrowse` shape
(slug/root-kind/limited dropped; children keep {path,title,section}; pages keep
{path,title,kind=role_heading??role,abstract}). Error messages match the JS NotFoundError
text (`Unknown framework: …`, `Page not found: …`, `No WWDC sessions indexed for …`).
mcp-parity **13/13** (pages, children, unknown-framework `isError`, draft-07 schema), full
native **112/112**. **Phase C's six cheap tools are all native** (search_docs, browse,
list_taxonomy, list_frameworks, search_sf_symbols, list_apple_fonts); read_doc + render +
Streamable HTTP `/mcp` + resources are Phase D.

### Records D–E — to be filled as the phases execute.
