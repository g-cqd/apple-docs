# Finalization Plan — apple-docs

**Drafted:** 2026-05-09
**Inputs:** `docs/audits/2026-05-09-*.md` (5 reports) + git log of remediation work to date.
**Goal:** close every open audit finding, drive the LOC ceiling exempt list to empty, land observability + MCP polish, and finish the half-done domain migration. After this plan, the project is "production-grade for a multi-tenant LLM-facing public MCP service."
**Constraint:** publicly reachable; CPU-constrained; RAM/disk plentiful; single committer.

---

## State at start of plan

Already landed (since the prior plan was drafted):

- `src/lib/lifecycle.js` — `unhandledRejection` / `uncaughtException` / `SIGINT` / `SIGTERM` graceful drain.
- `src/lib/safe-call.js` + cascade rewires; silent `catch{}` cleanup on the search path.
- `src/lib/errors.js` — typed errors; `fetchWithRetry` retry classification + GitHub secondary-RL handling.
- `src/storage/database.js`: 2147 → **395 LOC**. Repos split: `documents`, `pages`, `refs`, `roots`, `crawl`, `search`, `operations`, `assets-fonts`, `assets-symbols`. `pragmas.js` (incl. `PRAGMA foreign_keys = ON`). `migrations/` directory.
- Migration v14: `documents_trigram` → external-content FTS5.
- AbortSignal threaded through `Semaphore` / `Pool` / `fetchWithRetry`.
- `commands/search.js` decomposed into `search/{cascade,filters,format,fts-query-builder}`.
- `web/templates.js`: 1566 → **384 LOC**. Page templates extracted into `web/templates/`.
- `resources/apple-assets.js`: 1499 → **181 LOC**. `apple-fonts/`, `apple-symbols/`, `swift/`, `swift-templates.js`, plist parser extracted.
- Per-key render-cache invalidation; gzipSync removed; per-IP rate limit middleware.
- Random suffix on Swift renderer temp scripts.
- `pipeline/coalesce.js` — single-flight per-key on-demand fetch.
- `parse-html` `stripElements` ReDoS fix (linear single pass).
- `cli/formatter.js`, `consolidate.js`, `guidelines-parser.js`, `sources/packages.js` decomposed.

Quality gate today: 1512 tests pass; jscpd 41 clones; `bun audit` 9 advisories.

LOC ceiling — 12 files still over 400, exempt-listed:

| File | LOC |
|---|---|
| `src/content/normalize.js` | 964 |
| `src/content/render-html.js` | 918 |
| `src/content/parse-html.js` | 781 |
| `src/sources/wwdc.js` | 714 |
| `src/web/assets/symbols-page.js` | 696 |
| `src/web/build.js` | 619 |
| `src/mcp/server.js` | 570 |
| `src/mcp/pagination.js` | 534 |
| `src/resources/symbol-pdf-to-svg.js` | 487 |
| `src/commands/update.js` | 475 |
| `src/web/assets/collection-filters.js` | 469 |
| `src/web/assets/tree-view.js` | 435 |

12 offenders. The plan below empties this list as a side effect; it does not refactor for refactor's sake.

---

## Open audit findings, by severity

Pulled forward from the audits and re-checked against `HEAD`. Items already closed are omitted.

**Critical / High (must close):**

- A1. Render endpoints: text length, parameter allowlist, render concurrency cap, persistent cache LRU+TTL+quota. Spawn timeouts. *(Audits 4 §High, 3 §5, 5 §2.4)*
- A2. MCP HTTP origin default-deny for browser `Origin`; loopback + native pass. *(Audits 3 §1, 5 §2.4)*
- A3. MCP HTTP body size cap before buffering; reject Content-Length > 1 MB; streaming abort otherwise. *(Audits 4 §High, 3 §2)*
- A4. `keyPath` central traversal guard: reject `.`, `..`, empty segments, slashes inside decoded segments, absolute paths; `path.resolve(result).startsWith(path.resolve(dataDir))` invariant. *(Audits 3 §4, 5 §2.1, 4 §Medium)*
- A5. Snapshot install: pre-flight `tar -tzf` member validation (reject `..`, absolute, symlink/hardlink); extract to temp + atomic move; mandatory checksum. *(Audits 4 §Medium, 3 §3, 5 §2.1)*
- A6. Font `file_path` containment: store relative paths; resolve under approved roots; refuse outside. *(Audit 3 §8)*
- A7. SSRF amplifier on docs route: stricter per-IP rate limit (5 req/min); negative-cache misses 24 h; bounded queue (drop with 503 not buffer). *(Audits 4 §High, 3 §7, 5 §2.2)*
- A8. `bun audit` — clear 9 transitive advisories (upgrade `@modelcontextprotocol/sdk`, `@stryker-mutator/core`, lockfile). Add `bun audit` as blocking CI step. *(Audits 4 §Low, 3 §9, 5 §5.2)*
- A9. Half-finished `pages` → `documents` migration. Migration v15 kills `pages`, `refs`, `document_relationships`. *(Audits 5 §1.5, 4 §High)*

**Medium (should close):**

- A10. `search_docs.limit` and `browse.limit` — hard max in zod and command. *(Audits 4 §Medium, 3 §11)*
- A11. Lexicographic version filter — replace string-compare with normalized numeric, or move to JS post-filter. Regression test "iOS 9 vs iOS 10". *(Audits 3 §10, 5 §1.5)*
- A12. WWDC year/track post-filter silently truncates at 1000 rows. Per-source extension table `wwdc_session_meta(doc_id, year, track, speakers, duration)`. *(Audit 5 §1.5)*
- A13. 4-way kind taxonomy collapse. `documents.kind` as canonical; backfill; drop `role`, `role_heading`, `doc_kind` columns. *(Audit 5 §1.5)*
- A14. `min_*` columns → `document_platforms(doc_id, platform, min_version, beta)`; numeric version comparison in SQL. (Pairs with A11.) *(Audit 5 §1.5)*
- A15. Reader pool unbounded pending requests — max pending per worker, request deadline, cancellation propagation, overload error. *(Audit 3 §12)*
- A16. App-layer security headers — CSP, Permissions-Policy, COOP/CORP. Move inline 404 script to hashed external. *(Audit 3 §14, 5 §2.4)*
- A17. SLSA-style supply chain — pin actions to SHAs, add CodeQL + Scorecard, artifact attestation, verify provenance in `setup`. *(Audit 3 §15, 5 §5.2)*
- A18. `ops/lib/env.sh` shell-sourced `.env` in privileged flows — parse as data; validate ownership/mode. *(Audit 3 §16)*
- A19. Native process timeouts — shared spawn helper with deadline, kill, stdout/stderr byte caps. *(Audit 3 §17)*
- A20. `searchCache` LRU has no entry-byte cap — store IDs only or add byte cap. *(Audit 5 §2.7)*

**Low / correctness:**

- A21. `storage gc --older-than` deletes from `activity.timestamp` but column is `started_at`. *(Audits 4 §Low, 3 §18)*
- A22. `snapshotBuild --tag` strict regex on archive/checksum/manifest interpolation. *(Audit 3 §19)*
- A23. Font ZIP endpoint reads every file into memory; pre-build ZIPs or stream. *(Audit 3 §20)*
- A24. `Content-Disposition` filename sanitizer — RFC 5987 encoding. *(Audit 3 §21)*
- A25. Default crawl profile aggressive; require `--aggressive` for >100 in-flight. *(Audit 3 §23)*
- A26. `SECURITY.md` + responsible-disclosure process. *(Audit 3 §24, 5 §5.2)*
- A27. Stack-trace leakage in error responses (strip in prod). *(Audit 3 §High → 4.x; 5 §2.4)*
- A28. `safeJson.freezeJsonValue` recursive — switch to iterative; bounded depth guard. *(Audit 2 §1.2)*
- A29. Per-host rate-limiter map unbounded — LRU 256 cap. *(Audit 5 §2.2)*
- A30. Logger redaction layer for sensitive keys. *(Audit 5 §2.5)*

**SOTA / polish (open-ended):**

- A31. `outputSchema` + tool annotations (`readOnlyHint`, `idempotentHint`) on every MCP tool.
- A32. Prometheus `/metrics` endpoint exporting existing counters (cache hits/misses, semaphore wait/active/queued, reader-pool worker health, fetch retry counts, FTS query latency histogram).
- A33. `/readyz` distinct from `/healthz` — touches DB + reader-pool worker health.
- A34. OTEL spans (HTTP, MCP tool call, DB query top-level, reader-pool dispatch) behind env-flag.
- A35. Correlation IDs — `X-Request-Id` echo + child-logger context.
- A36. `checkJs: true` rolling adoption.
- A37. Embedding index over titles+abstracts (`sqlite-vec` MiniLM-L6) + hybrid `search_docs`.
- A38. Replace hand-rolled markdown with `micromark` (behind feature flag, A/B tested).
- A39. Replace hand-rolled HTML parser with `linkedom`.
- A40. Playwright e2e on web UI.
- A41. `npm publish --provenance`; cosign sign-blob on snapshot tarballs; verify on `setup`.

---

# Phases

Five phases. Each is self-contained: it can ship and improve the project even if the next never runs. Phases are sized for one committer; total ~3-4 calendar weeks for A-D, plus an open-ended E.

## Phase A — Audit-bundle: bound the work, not the access (3-4 days)

Closes every Critical/High audit finding that doesn't require a schema migration. No domain-model changes.

**A1 — Render endpoint hardening**
- `renderFontText` / SF Symbol render: text length cap (256), parameter allowlist (`size ∈ {8,12,16,20,24,32,48,64,96,128}`, `weight ∈ {ultralight…black}`, `scale ∈ {small,medium,large}`, `color` 6-char hex regex). 400 on violation.
- Persistent render cache: LRU + TTL (default 30 d, 5 GB cap).
- Web-side concurrency cap on render routes: shared semaphore (max 4); 503 with `Retry-After` on overflow.
- Native-spawn deadline: 10 s per Swift invocation; kill + stderr byte cap.

**A2 — MCP HTTP origin default-deny**
- When `--allow-origin` empty: presence of `Origin` header → 403. No-Origin clients (native MCP) still pass. Loopback origins (`http://localhost`, `http://127.0.0.1`) pass.
- Document the change in `docs/self-hosting.md`.

**A3 — MCP HTTP body cap**
- `Content-Length > 1_000_000` → 413 before any read.
- Streaming read for unknown length, abort at 1 MB.
- Helper extracted to `src/lib/http-body.js`.

**A4 — Central `validateStorageKey`**
- New helper in `src/lib/safe-path.js`. Reject `''`, `'.'`, `'..'`, segments containing `/` or `\\`, absolute paths.
- After `keyPath` resolves: assert `path.resolve(result).startsWith(path.resolve(dataDir))`.
- Threaded through `pipeline/persist.js` raw + normalized writers.

**A5 — Snapshot tar jail + mandatory checksum**
- `commands/setup.js`: pre-flight `tar -tzf` on archive; reject any entry where canonical resolution escapes `dataDir`; reject all symlinks/hardlinks. `--no-overwrite-dir --no-same-owner --no-same-permissions`. Extract to temp dir, then move expected files.
- Fail when `.sha256` asset is absent (no silent skip).
- Add fixtures: 3 hostile archives (`..` member, absolute path, symlink-then-write).

**A6 — Font path containment**
- Migration v15a: rewrite `apple_font_files.file_path` to be relative to `dataDir/resources/apple-fonts/`.
- Reads via `path.resolve(approvedRoot, relative)`; refuse if outside.

**A7 — Docs route SSRF amplifier limit**
- Per-IP token-bucket: 5 req/min on docs route when on-demand fetch triggers.
- Negative-cache misses for 24 h.
- Bounded fetch queue (drop with 503 not buffer).

**A8 — Dependency upgrade + `bun audit` in CI**
- `bun update --latest @modelcontextprotocol/sdk @stryker-mutator/core`. Re-run audit; expect 0.
- Add `bun audit` blocking step to `.github/workflows/ci.yml`.

**A21, A22, A24, A25, A27, A28, A29, A30** — small, surgical fixes; bundled into this phase since each is < 1 hour:
- `storage gc` → fix column name; add regression test.
- `snapshot --tag` strict regex `^[a-z0-9._-]{1,64}$`.
- `Content-Disposition` filename via RFC 5987 helper.
- Docs default to `--aggressive` flag for >100 in-flight; lower default in `cli.js` to 50.
- Strip stack traces in production (NODE_ENV=production) error responses; structured log keeps full stack.
- `freezeJsonValue` iterative with explicit work stack; depth guard 64.
- Per-host rate-limiter LRU 256.
- Logger redaction in `lib/logger.js`: redact keys matching `/token|secret|authorization|cookie|password/i`.

**Success criteria**
- Every Critical/High audit finding closed except A9 (deferred to Phase C).
- `bun audit` clean in CI.
- 1512 tests pass; +20 new tests (render-cap, origin matrix, body cap, traversal-key, font-path containment, snapshot tar fixtures, gc column).
- No file grew past its budget.

---

## Phase B — Close the LOC ceiling (4-5 days)

Pure decomposition phase. Twelve files exit the exempt list. Bundled with the small bugs each one hides.

**Content pipeline (the riskiest cluster)**

```
src/content/
  normalize/
    index.js                  (~120 LOC: orchestrator)
    sections/                 (one file per section kind, ≤120 each)
    coercion.js               (the 22 ?? section_kind sites consolidated)
  render-html/
    index.js                  (~150 LOC)
    sections/                 (mirror of above)
    markdown.js               (hand-rolled converter; replacement deferred to Phase E)
    escape.js
  parse-html/
    text-extract.js
    docc-meta.js
    strip-elements.js         (already linearised; just re-home)
```

`normalize.js` 964 → 0; `render-html.js` 918 → 0; `parse-html.js` 781 → 0. Tests: golden HTML snapshot per section kind; property-based `fast-check` round-trip on text-extract.

**Sources**

- `wwdc.js` 714 → `wwdc/{discover,session,transcript,assets}.js`. While here, fix the silent 1000-row truncation precondition documented in §A12 by adding pagination at the source layer (the schema-side fix is in Phase C).

**Web build**

- `web/build.js` 619 → ≤180 (orchestrator) + `web/build/{assets,static-pages,document-pages,framework-pages,atomic-swap}.js` (existing `worker-fanout`, `checkpoint`, `render-helpers`, `io` already extracted).

**Web client assets**

- `web/assets/symbols-page.js` 696 → `symbols-page/{index,filters,grid,detail-panel}.js`.
- `web/assets/collection-filters.js` 469 → `collection-filters/{state,render}.js`.
- `web/assets/tree-view.js` 435 → `tree-view/{model,render}.js`.

**MCP**

- `mcp/server.js` 570 → `mcp/{server.js (registration, ~150), tools/{search-docs,read-doc,browse,frameworks,kinds,doctor,assets,symbols}.js}` ≤120 each.
- `mcp/pagination.js` 534 → `pagination/{cursor,window,segment-too-large}.js`.
- `mcp/http-server.js` 400 — already at ceiling; the body-cap helper from A3 sheds enough lines to land it at ≤350.

**Resources**

- `resources/symbol-pdf-to-svg.js` 487 → `symbol-pdf-to-svg/{decode,inflate,latin1,svg-emit.js}` and move onto a worker thread (Audit 5 §3.8 #9 — synchronous decode blocks the event loop).

**Commands**

- `commands/update.js` 475 → split per phase: `update/{head-check,fetch,persist,tombstone}.js`. Tombstone requires N=3 consecutive 404s (Audit 5 §4.3).

**Success criteria**
- `.file-size-budget.json` exempt list is empty. CI gate flips from warning to hard error.
- jscpd ≤ 25 clones (down from 41 today).
- All ≥1512 existing tests pass; +30 new tests (one snapshot suite per section kind, MCP tool unit tests, symbols-page DOM smoke).
- No regressions on `bun run bench` (≤5%).

---

## Phase C — Domain model finalization + remaining medium audits (4-5 days)

Schema migration v15. Riskiest phase; canary first.

**A9 — Kill `pages` + `refs`**
- Migration v15 (in transaction):
  - Copy any `pages`-only rows into `documents` with `status='legacy'`.
  - Drop `pages`, `refs`, `document_relationships`.
  - Add `documents.status / etag / last_modified / downloaded_at`; rename `documents.key` → `path` (use `ALTER TABLE RENAME COLUMN` v3.25+).
- `getPage()` → `getDocument()`. Sweep ~60 call sites.
- Pre-merge gate: run on a real corpus snapshot, diff search results pre/post.
- Delete `repos/pages.js`, `repos/refs.js`.

**A11 + A14 — Numeric platforms**
- Migration v15a: `document_platforms(doc_id, platform, min_version_major, min_version_minor, min_version_patch, beta)` extension table.
- Drop `min_ios|macos|watchos|tvos|visionos` columns.
- `searchPages` predicate becomes a single JOIN.
- Regression test: search "iOS 9" vs "iOS 10" both return distinct correct sets.

**A12 — `wwdc_session_meta`**
- Migration v15b: extension table `(doc_id, year, track, speakers_json, duration_seconds)`.
- Wire WWDC source adapter to populate during sync.
- Replace JS post-filter in `search/filters.js` with a JOIN. Remove the 1000-row cap.
- Regression test: `wwdc year=2024` returns ≥ N (where N > 1000 expected sessions).

**A13 — Single canonical `kind`**
- Pick `documents.kind` (string). Migration v15c backfills from `role`/`role_heading`/`doc_kind` using the existing heuristic.
- Drop the other three columns.
- `matchesKindFilter` becomes a single SQL predicate.

**A10 — Bounded MCP limits**
- `search_docs.limit ≤ 100`, `browse.limit ≤ 200` in zod and command. 422 on overflow.

**A15 — Reader pool budget**
- Max 64 pending per worker; 5 s default deadline; cancellation propagates through `AbortSignal` plumbing already in place. Overload → 503 + retry-after.

**A19 — Native spawn helper**
- `src/lib/spawn-with-deadline.js`: shared deadline, kill on timeout, stdout/stderr byte caps. Re-home all `Bun.spawn` callsites (Swift renderer, tar, hdiutil, git).

**A20 — `searchCache` byte cap**
- Configure `LRU(maxBytes=64MB)` over current `LRU(max=512)` count-only cap. Bytes computed on insert via `JSON.stringify` length (cheap for cached arrays).

**A23 — Font ZIP streaming**
- Pre-build per-family ZIPs at sync time; cache on disk. Route serves via `Bun.file(zipPath)` → no in-memory build.

**Success criteria**
- `pages`, `refs`, `document_relationships`, four kind columns, five min-version columns: all gone. Schema at v15+.
- WWDC search no longer truncates.
- Lexicographic version-filter regression test green.
- Mutation testing on `repos/search.js` ≥ existing baseline.
- Migration canary green: pre/post row counts match; 1000 random `SELECT *` diffs identical except for the new shape.

---

## Phase D — Observability, MCP polish, supply chain (3-4 days)

**A31 — `outputSchema` + tool annotations**
- All 11 MCP tools get a zod `outputSchema` describing current responses (not changing them) plus `annotations: { readOnlyHint: true, idempotentHint: true }`.
- Add MCP contract test: every tool's response validates against its declared schema.

**A32 — Prometheus `/metrics`**
- Off by default; `--metrics-port 9090` enables. Export existing counters: `mcp/cache.js` hits/misses/stamps, `Semaphore` wait/active/queued, reader-pool worker health, `fetchWithRetry` retry counts, FTS query latency histogram.

**A33 — `/readyz`**
- Distinct from `/healthz`. Touches DB (`SELECT 1`), checks reader-pool has alive workers. Watchdog updated to consume `/readyz`.

**A34 — OTEL spans**
- `@opentelemetry/api` + OTLP HTTP exporter, env-flag `APPLE_DOCS_OTEL_ENDPOINT`. Wrap: HTTP request, MCP tool call, top-level DB query, reader-pool dispatch. Spans only.

**A35 — Correlation IDs**
- `X-Request-Id` echo; propagate through `lib/logger.js` child-context (pino-style `child(fields)`).

**A16 — App-layer security headers**
- CSP with `script-src 'self' 'sha256-…'` after extracting the inline 404 script to a hashed external file.
- `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` defaults. Tests for headers.

**A17 — Supply-chain hardening**
- Pin all `.github/workflows/*.yml` actions to commit SHAs (Dependabot keeps them updated).
- Add `.github/workflows/codeql.yml` + Scorecard workflow.
- `actions/attest-build-provenance` on release artifacts.

**A18 — Ops `.env` parsing**
- Replace `source ops/.env` in `ops/lib/env.sh` with a parser that reads key=value, validates file mode `0o600`, validates owner == process owner.

**A26 — `SECURITY.md`**
- Disclosure process, supported versions, contact channel, scope.

**Success criteria**
- All 11 MCP tools have `outputSchema`. Contract test passes.
- `apple-docs mcp serve --metrics-port 9090` serves Prometheus; `--otel http://…` produces traces.
- `/readyz` returns 503 on simulated DB stall.
- CodeQL + Scorecard on every PR. Actions pinned to SHAs.
- `SECURITY.md` published.

---

## Phase E — SOTA & polish (open-ended; pick when motivated)

Lower priority. None of these are correctness or security; they're where the project's LLM-affordance ceiling currently sits.

- **A37 Embedding index** — MiniLM-L6 over `(title + abstract)`, ~100 MB index in `sqlite-vec`. Hybrid `search_docs` reranks with semantic score after lexical cascade. Lazy-load model; cap concurrent inference at 2; `--no-semantic` flag. *Single biggest LLM-affordance lift.*
- **A36 `checkJs: true` rollout** — flip flag with `// @ts-nocheck` shim per file; convert one file per commit, starting at `repos/documents.js`, `repos/search.js`, `mcp/server.js`, `web/context.js`.
- **A38 Replace hand-rolled markdown with `micromark`** — feature flag, A/B against current renders, swap when diff is acceptable.
- **A39 Replace hand-rolled HTML parser with `linkedom`** — extended test corpus first.
- **A40 Playwright e2e** — search interactions, symbol gallery filters, font preview.
- **A41 SLSA / cosign / npm provenance** — `cosign sign-blob` on snapshot tarballs; verify on `apple-docs setup`; `npm publish --provenance`.

---

# Code-quality enforcement

Already in place; phase B flips the gate from warning to hard error.

1. `scripts/check-file-size.js` reads `.file-size-budget.json`. Today: warns on exempt list growth. After Phase B: empty exempt list, hard fail at >400 LOC. Soft target 300; CI nudge only.
2. `bun run lint:duplication` (jscpd): tighten 41 → 30 (B) → 20 (C) → 15 (D).
3. `bun audit` blocking in CI (Phase A).
4. `tsc --noEmit` (already on); `checkJs: true` rollout in Phase E.
5. PR-template checkbox: "Files touched: all under 400 LOC."

---

# Risk register

| # | Item | Phase | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| R1 | Migration v15 (kill pages/refs) | C | L | Critical | Pre-migration snapshot; transactional; canary on real-corpus copy with row-count + 1000-row sample diff. |
| R2 | Numeric version refactor | C | M | M | Regression test "iOS 9 vs iOS 10"; keep rollback migration scripted. |
| R3 | Render-cache LRU+TTL+quota (A1) | A | L | M | Generous defaults; `--no-cap` escape hatch; smoke test cache eviction under load. |
| R4 | MCP origin default-deny breaks unknown clients | A | L | M | Document loopback exemption; emit one-line warning the first time a request is rejected. |
| R5 | Tar jail rejects benign archives | A | L | L | Test against current snapshot tarballs in CI before release. |
| R6 | Reader-pool deadline cancels long FTS queries | C | M | M | Tunable per-call deadline; default 5 s; metric for timeout count. |
| R7 | OTEL/Prometheus exporters add startup cost | D | L | L | Off by default; lazy-init on first export. |
| R8 | Embedding index inference on CPU-constrained host | E | M | M | Lazy-load model; concurrent cap 2; `--no-semantic` flag. |
| R9 | `checkJs` rollout uncovers latent type errors | E | H | M | Per-file shim; one file per commit; tracked via `scripts/typecheck-coverage.js`. |

---

# Schedule

| Phase | Effort | Calendar | Audit findings closed |
|---|---|---|---|
| A — Audit bundle | 3-4 days | Week 1 | A1-A8, A21-A30 (~20 items) |
| B — LOC ceiling | 4-5 days | Week 2 | (12 LOC offenders → 0) |
| C — Domain finalization | 4-5 days | Week 3 | A9-A15, A19-A20, A23 |
| D — Observability + supply chain | 3-4 days | Week 4 | A16-A18, A26, A31-A35 |
| E — SOTA & polish | open | post | A36-A41 |

**Total to "every Critical/High/Medium audit item closed + LOC ceiling enforced":** ~3-4 weeks (A-D).

---

# Out of scope

- Auth on public MCP HTTP — deliberately deferred; project must remain publicly reachable. A2 (browser-origin default-deny) is the cheap win that doesn't compromise that constraint.
- Default `127.0.0.1` bind on web — same reason.
- Replacing `bun:sqlite` with libSQL/postgres — unnecessary; current store fits the workload.
- Multi-tenancy / per-user state — not a project goal.
