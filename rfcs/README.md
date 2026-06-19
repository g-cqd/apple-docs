# RFCs — the Swift-native transition roadmap

Living index. Phase definitions live in
[RFC 0001](0001-swift-native-transition.md); this file is the CURRENT
dashboard — status + what's next. Repo documentation only, not built or
indexed by the docs site.

## RFC index

| RFC | Carries | Status |
| --- | --- | --- |
| [0001 — Swift-native transition](0001-swift-native-transition.md) | The master plan: P0–P7, bridge architecture, dependency policy, §10 improvement track | **Living** |
| [0002 — Swift embedder](0002-swift-embedder.md) | P2 | **COMPLETE** (2026-06-12) — records in [`0002-swift-embedder/`](0002-swift-embedder/records.md) |
| [0003 — Swift render service](0003-swift-render-service.md) | P3 | **Phases 1/2/4 done; phase 3 held** (2026-06-13) — records in [`0003-swift-render-service/`](0003-swift-render-service/records.md) |
| [0004 — Swift content pipeline](0004-content-pipeline.md) | P4 | **Main line done; phases 3-4 NO-GO** (2026-06-12/13) — records in [`0004-content-pipeline/`](0004-content-pipeline/records.md) |
| [0005 — Server framework + MCP](0005-server-framework.md) | P6 (servers): the type-safe server DSL + native MCP protocol | **In progress** (2026-06-14) — records in [`0005-server-framework/`](0005-server-framework/records.md) |
| [0006 — Codebase health & conformance](0006-codebase-health.md) | Standing: concern separation + Apple-native safe-type adoption | **In progress** (2026-06-14) — records in [`0006-codebase-health/`](0006-codebase-health/records.md) |
| [0007 — P7: CLI + static binary](0007-p7-cli-static-binary.md) | P7: swift-argument-parser CLI, ops ports, one static binary, Bun sunset | **Planned** (2026-06-19) — sequenced behind P5/P6/0006 |

## Where we are — the P0–P7 ladder

| Phase | Scope | Status |
| --- | --- | --- |
| **P0** | Toolchain, CI, FFI skeleton | ✅ Done |
| **P1** | Fusion + tar.zst archiver native (ranking/snippets ride P6) | ✅ Done / closed |
| **P2** | Embedder ([RFC 0002](0002-swift-embedder.md)) | ✅ Complete |
| **P3** | Render service ([RFC 0003](0003-swift-render-service.md)) | ◑ Phases 1/2/4 done; **phase 3 held** |
| **P4** | Content pipeline ([RFC 0004](0004-content-pipeline.md)) | ✅ Main line done; phases 3-4 NO-GO |
| **P5** | Storage — SQLite C-interop, reader pool → native actors | ◑ Foundation shipped (token-gated **off**); bridge-flip NO-GO, deferred to P6 |
| **P6** | Servers — web + MCP on SwiftNIO (no Vapor) | ◑ Host viable + safe (async, **no `@unchecked`**); **serving-win achieved** + **`/search` COMPLETE — full byte-parity** (34/34): enrichment (snippet+relatedCount, zstd codec), all tiers (title-exact/FTS/trigram/fuzzy/body), relaxation R1-R3, filters (kind/source/language/platform/deprecated), framework synonyms — vs JS `search()` (semantic tier out of scope). The ~390 c16 ceiling was **SQLite's global `MEMSTATUS` allocator mutex** — one `sqlite3_config(MEMSTATUS,0)` (C shim): c16 **383→2263** (synthetic, ~2× Bun) / **27→51** (real 4GB, ≈ Bun 58), TSan-clean. **Custom-scheduler plan obsoleted.** 2nd mutex (`pcache1` group, Homebrew build) caps both on real corpus — deferred. **Web API backend COMPLETE** (`91fc3e6`→`cf0c813`): the 13 cheap `/api/*`+`/data/*`+discovery routes ported to ad-server, **intrinsically identical** to the Bun handlers (19 parity cases) — JSON via **ADJSON** (`g-cqd/ADJSON`: `Encodable` models + `JSONValue`; the `JSONStreamWriter` byte-parity SPI co-designed + shipped to ADJSON). Gate relaxed byte→**intrinsic** (deep-equal parsed JSON) per operator. The **MCP protocol + a type-safe server-DSL refactor** are now [RFC 0005](0005-server-framework.md) (in progress; engine/endpoints/logic decoupled into ADServeCore/ADServeDSL/Services); the live flip stays operator-gated (Caddy split + launchd unit wired-ready, off). Codebase-health/conformance track → [RFC 0006](0006-codebase-health.md) |
| **P7** | CLI + single static binary; Bun retired ([RFC 0007](0007-p7-cli-static-binary.md)) | ⬜ Planned — RFC authored |

Every bridge-era module — `fusion`, `archive`, `embed`, `content`,
`render` — is native-by-default with a bit-identical JS fallback
(`APPLE_DOCS_NATIVE`). The hot/heavy compute is ported; what remains is the
**storage layer (P5), the servers (P6), and packaging (P7)**.

## Work ahead

**Main line (sequential):**
- **P5 — Storage** (first slice done; flip deferred): the native read
  foundation (`ADStorage`, dlopen'd libsqlite3) + `searchPages` shipped
  **token-gated off** — byte-parity + WAL-safe, but native-via-FFI is
  ~7-16% slower than the already-native bun:sqlite (NO-GO for a bridge-era
  flip; the win is P6/P7-coupled). D4 settled: raw C interop. The
  foundation is the P6 prerequisite. *Kills* (`bun:sqlite`, the `Worker`
  pool) are P7-coupled (unkillable while Bun is runtime + writer). Records:
  [p5](0001-swift-native-transition/p5/records.md).
- **P6 — Servers**: in-house SwiftNIO web + MCP; *kills*
  `@modelcontextprotocol/sdk`, `zod`, `Bun.serve`. Ranking/snippets fold in.
  **Web routes done** (`/search` + the 13 cheap `/api/*`+`/data/*`+discovery, all
  intrinsically Bun-identical, JSON via ADJSON). The rest now runs as
  **[RFC 0005](0005-server-framework.md)** — a type-safe server DSL (result builders +
  typed `Path` + modifiers) that decouples engine/endpoints/logic, the native MCP
  protocol (stdio + Streamable HTTP, `@ToolInput` macro replaces `zod`), and then the
  operator-gated Caddy/launchd flip. Conformance/health → **[RFC 0006](0006-codebase-health.md)**.
- **P7 — CLI + single binary** ([RFC 0007](0007-p7-cli-static-binary.md)):
  swift-argument-parser, ops ports, one static Swift binary per platform;
  retires Bun + all `package.json` runtime deps.

**Held / open / latent:**
- **P3 phase 3** — darwin spawn-script kills, gated on a release cycle at
  native-default (they are the `=off` escape hatch's fallback).
- **§10(E)** snapshot/storage size (the 2.47 GB asset ceiling); **RFC 0004
  phase 3** crawl-time normalize (eval/contentHash-gated).
- **Render-native dup-dylib CI flake** — the macOS symbol-pdf parity test
  intermittently fails when both the staged + `swift/.build` dylibs load;
  worth hardening (separate from the transition).

**§10 improvement track** (RFC 0001 §10): A / B / B′ done, C resolved, D
folded into P3, **E open**, F NO-GO.

## Why this order (measured)

Query latency is ~99% inside SQLite — porting query-path JS wins nothing on
latency; SQL-layer improvements do (§10(B) cut p50 2.5–5×). The content
static build is IO-bound, not render-bound (P4 phases 3-4 NO-GO). Render
one-shots paid ~200 ms JIT on cache miss (P3-darwin, now native). P5 starts
once P2 + P3-darwin are native-by-default — both true. Detail in the owning
RFCs + their records.

## Doctrine pointers

- Parity-first porting + per-module kill switch: RFC 0001 §4.
- Beyond parity (the two-step rule, gate matrix, reference-flip rule,
  candidate registry): RFC 0001 §10.
- Dependency policy (apple/swiftlang/pointfreeco + system C libs;
  exception mechanism): RFC 0001 §2.

*Maintenance*: update this dashboard when a phase starts/finishes or the
order changes; dated detail belongs in the owning RFC's records.
