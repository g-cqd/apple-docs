# RFC 0006 — codebase health & conformance

- **Status: In progress** (opened 2026-06-14). A standing track — the Swift mirror
  of a recurring quality audit: concern separation, safe-type adoption, coherence /
  consistency / reliability / integrity, and conformance to Apple/ecosystem norms.
- Parent: [RFC 0001](0001-swift-native-transition.md) §6 (state-of-the-art Swift
  guidelines) + §10 (the improvement-track gate matrix governs every fix here).
- Sibling: [RFC 0005 — server framework](0005-server-framework.md) is where this
  RFC's safe-type doctrine is adopted **first** (new code sets the bar).
- **Detailed audit + the prioritized backlog**: [`records.md`](0006-codebase-health/records.md).
- Repo-internal: never built or indexed by the docs site.

## 1. Why

The Swift modules grew fast under the transition (P0→P6). A health pass found the
package fundamentally sound (well-scoped modules, a disciplined `@unchecked`
inventory, typed errors in the newer modules) but with consistency gaps that hurt
readability and safety: **stringly-typed HTTP headers**, `print()` logging, a
hand-rolled UUID/hex, untyped `throws` in older modules, a few **concern-mixing
files** (routing+SQL+JSON together), duplicated row-decode logic, and two
`@unchecked Sendable` types whose thread-safety is documented rather than typed.
None are bugs; all are conformance debt that compounds. This RFC records the audit,
fixes the doctrine, and schedules the cleanup so it lands as evidence-gated slices,
never as drive-by churn inside a feature.

## 2. Doctrine

- **D-0006-1 — adopt-in-new-code (operator, 2026-06-14).** New code (starting with
  RFC 0005's framework) adopts the safe-type vocabulary from day one. Existing
  modules are a **scheduled backlog** — fixed as their own slices, not forced into
  unrelated work. The §10 two-step rule applies: a behavior-preserving cleanup is
  separate from any behavior change, and each cleanup declares a §10 gate category
  (almost always *pure-perf / no-output-change* → all parity suites unchanged).
- **One file = one responsibility.** Routing, serialization, and SQL do not share a
  file; engine / endpoint-wiring / business-logic do not share a module (RFC 0005
  enforces this for the server).

## 3. The safe-type adoption matrix (D-0006-2)

The canonical "use the Apple-native safe type" list. New code conforms; the backlog
(§5) migrates existing call sites.

| Domain | Avoid | Adopt | First adopter |
| --- | --- | --- | --- |
| HTTP headers / status | `[(String,String)]`, raw status ints/strings | **swift-http-types** `HTTPField`/`HTTPField.Name`/`HTTPFields`/`HTTPResponse.Status` | ADServeCore |
| Logging | `print()` | **swift-log** `Logger` (structured, levelled) | ADServeCore |
| Identifiers / params | bare `String` for scopes, slugs, keys | **`Tagged`** / domain `enum` (`SymbolScope`, `FrameworkSlug`, `DocKey`) | ADServeDSL |
| URLs / paths | base-url `String` munging | **`Foundation.URL`/`URLComponents`** | ADServeCore (SiteConfig) |
| Request ids / uuids | hand-rolled v4 mint + hex loop | **`UUID`** (parity-excluded field) | ADServeCore |
| Errors | untyped `throws`, `Optional` swallowing | **typed `throws`** + rich error enums | framework-wide |
| Time | `Int`/`Double` ms, per-call `ISO8601DateFormatter()` | **`Duration`/`ContinuousClock`**; a shared static formatter | as touched |
| Bytes / payloads | ad-hoc `[UInt8]` where a value type fits | `Data`/`Codable`/ADJSON models where it adds safety (not where `[UInt8]` is the hot contract) | as touched |
| MIME / content types | bare strings | `UTType` where a registered type exists | as touched |

(`swift-http-types`/`swift-log` are apple/*; `swift-tagged` is pointfreeco/* — all
§2-compliant. `Tagged 0.10.0` is pre-1.0; pinned in `Package.resolved`.)

## 4. Findings (summary — detail + file:line in records.md)

- **Modules**: 9 libraries + 2 executables; mostly well-scoped. 5 files > 400 LOC;
  the actionable concern-mixers are `ADContent/PageMarkdown.swift` (703),
  `ADStorage/PreparedStatement.swift` (SQL bind + row codec + JSON in one),
  `ADSearchCascade/Cascade.swift` (orchestration + snippet render), and the
  server's `WebRoutes.swift` (routing + SQL + JSON) which **dissolves under RFC 0005**.
- **`@unchecked Sendable`**: 12 instances, all audited — most justified (dlopen'd
  function tables immutable post-init; mutex-protected registries; immutable-post-init
  mmap/tape). **Two are "discipline, not type"**: `ADStorage/StorageConnection.swift:9`
  (public) + `ADStorage/Connection.swift:14` — one-thread-at-a-time enforced by pool
  checkout, not by the type. Hardening item (§5).
- **Safe-type gaps**: the matrix above, instantiated at `WebResponse.swift:62`
  (header tuples), `Main.swift` (`print()` ×5), `WebResponse.swift:141-156` (UUID),
  the untyped `throws` in `ADArchive`/`ADBase`, base-url `String` in `SiteConfig.swift`.
- **Duplication**: per-query column extraction reimplemented across
  `ADStorage/{SearchRow,Filters,Assets,FrameworkTree}.swift` (no shared `RowDecoder`);
  `JsString`/`CaseFolding` live in `ADContent` but are used by `ADEmbed`/
  `ADSearchCascade` (no shared util module).

## 5. Backlog (scheduled — §10 gate category in brackets)

| # | Item | Where | Status |
| --- | --- | --- | --- |
| H1 | Headers/status → swift-http-types | ADServeCore (new) | **adopt in RFC 0005 Phase B** |
| H2 | `print()` → swift-log | ADServeCore (new) + Main | **adopt in RFC 0005 Phase B** |
| H3 | UUID/hex → `UUID` + Crypto hex | ADServeCore (new) | **adopt in RFC 0005 Phase B** |
| H4 | Domain enums/`Tagged` for params | ADServeDSL (new) | **adopt in RFC 0005 Phase B** |
| H5 | Delete dead `WebRoutes`/`WebResponse` after the DSL port | ADServer | RFC 0005 Phase E |
| H6 | Shared `RowDecoder` (dedup column extraction) | ADStorage | scheduled |
| H7 | Shared util module for `JsString`/`CaseFolding` | new ADText (or ADBase) | scheduled |
| H8 | Split the concern-mixing files | PageMarkdown / PreparedStatement / Cascade | scheduled |
| H9 | Harden the 2 moderate `@unchecked` (type the single-thread invariant, or document the contract in one place) | ADStorage | scheduled |
| H10 | Typed `throws` sweep for the older modules | ADArchive/ADBase | scheduled (pure-perf gate) |
| H11 | Reuse a static `ISO8601DateFormatter` | ADServer | with H1–H4 |

## 6. Gates

Each backlog slice is *pure-perf / no-output-change* unless stated: it lands only if
**all parity suites stay unchanged** (the §10 matrix). H1–H4 are validated by RFC
0005's route/MCP parity gates (the cleanup IS the framework). swift-format stays the
CI style gate; an aspirational lint (headers must go through `HTTPFields`; no `print`
in server code) is a possible later addition.

## 7. Outcome

*To be filled as backlog items land — see [`records.md`](0006-codebase-health/records.md).*

---
*Maintenance*: as items land, flip their §5 status + add a dated note to
[`records.md`](0006-codebase-health/records.md). New audits append a findings section.
