# RFC 0006 — codebase health: audit detail + records

Parent contract: [`../0006-codebase-health.md`](../0006-codebase-health.md).
Repo documentation; never built or indexed by the docs site.

## Audit 1 — 2026-06-14 (Swift side, pre-RFC-0005)

Scope: the `swift/` package as of the P6 web slice (`cf0c813`). Read-only.

### Module map

9 library targets + 2 executables (from `swift/Package.swift`). Dependency flow
(low → high): `ADBase` → {`ADSearch`, `ADArchive`, `ADEmbed`, `ADRender`, `ADContent`,
`ADStorage`} → `ADCore` (the dylib) ; server-only: `ADStorage`+`ADContent`+`ADBase`
→ `ADSearchCascade` → `ADServer` (exe, + swift-nio/crypto/ADJSON). `CSQLiteShim` (C)
under ADStorage; `ad-embed-dump` (exe) under ADEmbed.

Approx sizes (LOC): ADContent ~2,061 · ADEmbed ~1,754 · ADStorage ~1,611 ·
ADBase ~1,355 · ADSearchCascade ~1,289 · ADServer ~1,260 · ADCore ~1,215 ·
ADArchive ~669 · ADRender ~653 · ADSearch ~133 · CSQLiteShim ~13.

### Concern-separation findings (file:line)

- `ADContent/PageMarkdown.swift` (703) — markdown parse + inline render + xref +
  front-matter in one file; split into parser / span-builder / renderer.
- `ADStorage/PreparedStatement.swift` (333) — SQL binding + row codec/type-tagging +
  JSON framing (three responsibilities).
- `ADSearchCascade/Cascade.swift` (348, ~275-280) — tier-merge + enrichment batching
  + JSON snippet assembly; dips into `ADContent.PlainText` directly (a server-only
  query layer reaching into the presentation layer).
- `ADServer/WebRoutes.swift` (331) — every handler couples ADStorage queries with
  JSON frame-building; **dissolves under RFC 0005** (routing→DSL, JSON→ResponseContent,
  SQL→Services).
- `ADCore/ContentExports.swift` (369) — FFI marshalling intermixed with content
  orchestration.
- Org: `ADStorage/` flat-files low-level C-interop (`Connection`/`SQLiteLib`) next to
  high-level queries (`SearchPages`/`Assets`/`FrameworkTree`); no `Routing/`/`Models/`
  subfolders anywhere (acceptable now; note for growth).

### `@unchecked Sendable` inventory (all 12)

| File:line | Type | Justification | Verdict |
| --- | --- | --- | --- |
| ADCore/ContentExports.swift:238 | `DocJob` | mutable buffer refcount in DispatchQueue ctx | keep (internal) |
| ADCore/ContentExports.swift:245 | `PlainJob` | same | keep (internal) |
| ADCore/EmbedExports.swift:38 | `EmbedRuntime` | onnx session under process mutex | keep (singleton) |
| ADRender/HarfBuzzShaper.swift:43 | `HarfBuzzLib` | dlopen fn-ptr table, immutable | keep |
| ADStorage/Connection.swift:14 | `Connection` | sqlite3* one-thread-at-a-time, external discipline | **harden (H9)** |
| ADStorage/SQLiteLib.swift:43 | `SQLiteLib` | dlopen fn-ptr table, immutable | keep |
| ADStorage/StorageConnection.swift:9 | `StorageConnection` (public) | one-thread via pool checkout, documented | **harden (H9)** |
| ADStorage/Registry.swift:17 | `ConnectionRegistry` | u64→Connection, Mutex-guarded | keep |
| ADBase/JsonTape.swift:37 | `JsonTape` | immutable post-`parse()` | keep |
| ADBase/BatchResult.swift:25 | `ResultsCell` | short-lived buffers in DispatchQueue ctx | keep |
| ADEmbed/MatrixArtifact.swift:21 | `MatrixArtifact` (public) | read-only mmap, immutable post-init | keep |
| ADArchive/Zstd.swift:41 | `ZstdLib` | dlopen fn-ptr table, immutable | keep |

10 justified-and-kept; 2 (`StorageConnection`/`Connection`) get H9 — the single-thread
invariant is enforced by callers, not the type.

### Safe-type gaps (file:line → backlog item)

- `ADServer/WebResponse.swift:62-70` — `securityHeaders: [(String,String)]` + ad-hoc
  status → swift-http-types (**H1**).
- `ADServer/Main.swift` (`print()` at startup/error, ×5) → swift-log (**H2**).
- `ADServer/WebResponse.swift:141-156` — hand-rolled `mintUUIDv4()`; `:84-95` hex loop
  → `UUID` + Crypto digest hex (**H3**).
- stringly params (`scope: String` "public"/"private"; framework slug; doc key) across
  `WebRoutes.swift`/`Serving.swift` → domain enums / `Tagged` (**H4**).
- `ADServer/SiteConfig.swift` — base-url stored/trimmed as `String` →
  `Foundation.URL`/`URLComponents` (parity-checked).
- untyped `throws`: `ADArchive/ArchiveWriter.swift:67`, `ADBase/JsonTape.swift:71`,
  `ADBase/Json.swift:118` (vs the typed `throws(EmbedError)`/`throws(TarFailure)`
  already in ADEmbed/ADArchive/Tar) → typed-throws sweep (**H10**).
- per-call `ISO8601DateFormatter()` at `WebRoutes.swift:149` → shared static (**H11**).

### Duplication

- Column extraction reimplemented in `ADStorage/{SearchRow,Filters,Assets,
  FrameworkTree}.swift`; no shared `RowDecoder` (**H6**).
- `JsString`/`CaseFolding` in `ADContent` used by `ADEmbed` (tokenizer) +
  `ADSearchCascade` (fuzzy); no shared util module (**H7**).

### JS side (context, unchanged)

363 files / 14 folders, clear separation (`src/web` 83 · `src/storage` 51, all
`bun:sqlite` confined · `src/mcp` 14 · `src/commands` 34 · `src/output` 2 projection).
The native bridge is fully in place; the JS side is untouched by this RFC.

## Records

### Record A — audit recorded; doctrine + backlog set (2026-06-14)
This audit + the §3 matrix + the §5 backlog written. H1–H4 are scheduled to land *as*
RFC 0005 Phase B (the framework adopts the safe types); H5 at Phase E; H6–H11 as their
own gated slices. No code changed in this record.

### Record B — H1/H2/H3/H5 landed with RFC 0005 Phase B (2026-06-14)
The new server framework adopted the safe-type vocabulary from day one:
- **H1** — all headers/status flow through swift-http-types (`HTTPFields`/`HTTPField.Name`/
  `HTTPResponse.Status`); the `[(String,String)]` tuples are gone (the constant envelope
  is built once as `HTTPFields` in `Endpoints.swift`).
- **H2** — server startup/listen logs go through swift-log (`Logger`); usage/errors go to
  stderr (`FileHandle`); the only remaining `print` is the `--bench` result line (a CLI
  diagnostic, intentional stdout).
- **H3** — request-id minting is `UUID().uuidString.lowercased()` (the hand-rolled v4 is
  gone). The SHA-256→hex helper keeps a manual lowercase loop deliberately — it must be
  byte-exact to JS `digest('hex')`, and Crypto's digest has no stable hex rendering to
  rely on.
- **H5** — `WebResponse.swift`, `Serving.swift`, and the app's `ConnectionPool.swift` are
  deleted; the dispatch switch + the hand-built envelope are gone. `WebRoutes.swift`
  remains as the JSON-builder business logic (it no longer mixes routing).
- **H4 deferred** — the routing is type-safe (typed matcher captures, the `StorageContext`
  connection invariant), but domain params (`scope`, slug, key) stay `String`; introducing
  `SymbolScope`/`Tagged` would push types into ADStorage signatures (scope creep for the
  refactor). The swift-tagged dependency was **removed** (unused) until that slice lands.

### Records C+ — to be filled as backlog items land.
