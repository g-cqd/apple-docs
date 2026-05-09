# Phase 3+ Plan: Code Quality + Audit Remediation

**Repo:** apple-docs @ `d27b946`
**Drafted:** 2026-05-09
**Constraints:** CPU-only constrained, RAM/disk plentiful (64 GB / 100+ GB), **must remain publicly reachable**.
**Total estimated effort:** ~6 calendar weeks of focused work, sized for a single committer.

The plan deliberately interleaves refactor with bug-fix: the god modules are where the worst bugs live, so we crack each one open, fix what was hidden inside, land the perf wins on the now-small files, and re-run the gate. We never refactor first then fix later — that loses the audit traceability.

Inputs: see `docs/audits/2026-05-09-*.md` (5 separate audit reports).

---

## Files Currently Over the 400-LOC Ceiling

| File | LOC | Phase touched |
|---|---|---|
| `src/storage/database.js` | **2147** | Phase 2 |
| `src/web/templates.js` | **1566** | Phase 3 |
| `src/resources/apple-assets.js` | **1499** | Phase 3 |
| `src/content/normalize.js` | 964 | Phase 4 |
| `src/content/render-html.js` | 918 | Phase 4 |
| `src/web/build.js` | 896 | Phase 3 |
| `src/content/parse-html.js` | 732 | Phase 4 |
| `src/sources/wwdc.js` | 714 | Phase 4 |
| `src/web/assets/symbols-page.js` | 695 | Phase 4 |
| `src/mcp/server.js` | 566 | Phase 5 |
| `src/commands/search.js` | 559 | Phase 2 |
| `src/mcp/pagination.js` | 534 | Phase 5 |
| `src/sources/packages.js` | 522 | Phase 4 |
| `src/resources/symbol-pdf-to-svg.js` | 487 | Phase 3 |
| `src/commands/update.js` | 475 | Phase 1 (retire/keep decision) |
| `src/web/assets/collection-filters.js` | 469 | Phase 4 |
| `src/commands/consolidate.js` | 438 | Phase 4 |
| `src/web/assets/tree-view.js` | 435 | Phase 4 |
| `src/cli/formatter.js` | 424 | Phase 4 |
| `src/apple/guidelines-parser.js` | 417 | Phase 4 |
| `src/mcp/http-server.js` | 397 | Phase 1 (already touched, stays under) |

20 files over budget. Total reduction target: ~17 K LOC reorganized, **zero behavioral change** on hot paths.

---

## Phase 1 — Stop the Bleeding (3-4 days)

Small, surgical, no architectural moves. Every item here is high-severity-low-effort and unblocks the rest.

### Goals
- All Critical security/reliability findings closed.
- LOC ceiling enforcement infrastructure landed (warning-only first).
- Orphaned-command decision committed.

### Code-quality work
- **Land `max-lines` enforcement.** Add `scripts/check-file-size.js` that fails CI on any new file > 400 LOC, warns on existing > 400 (with an exempt-list seeded from today's offender list). Exempt list shrinks every phase.
- **CI gate:** new file = hard 400 LOC ceiling. Existing file = must not grow. Add to `.github/workflows/ci.yml`.
- **Orphaned-command resolution** (corrected by re-tracing imports — three of four are NOT orphans):

| Command | Verdict | Why |
|---|---|---|
| `snapshot.js` | **Wire as `apple-docs snapshot build`** | Used by `scripts/build-snapshot.js` and `commands/setup.js`. Currently CLI-invisible despite being the release pipeline. Wire + document. |
| `consolidate.js` | **Wire as `apple-docs consolidate`** | Called by setup-smoke + checkpoint-resume tests; presumably also by sync flow internally. Wire + document. |
| `index-rebuild.js` | **Wire as `apple-docs index rebuild [body\|trigram]`** | Used by setup-smoke. Operators need this when an FTS index gets corrupted. |
| `update.js` | **Keep as internal helper** | *Initial brief said "retire"; revised after grep miss.* `src/commands/sync.js:12` imports `./update.js` for the HEAD-check phase. Not a CLI-orphan in the same sense as the other three — it's a private module that just happens to have its own tests. No CLI surface, no rename. |

### Security/reliability bundle
1. **Process lifecycle** — install `process.on('unhandledRejection'|'uncaughtException')` in `cli.js` and `index.js`. Wire SIGINT/SIGTERM through a single `gracefulShutdown(reason, deadlineMs)` helper that drains: HTTP `server.stop(false)` → reader-pool fan-out join → DB `WAL_CHECKPOINT(TRUNCATE)`. 30 s deadline, then `process.exit(1)`.
2. **launchd** — set `ExitTimeOut: 30`, `KeepAlive: { SuccessfulExit: false }` in all four `.plist.tpl`.
3. **Snapshot tar jail** — pre-flight `tar -tzf` on archive, reject any entry where `path.resolve(dataDir, member)` is not under `path.resolve(dataDir)`, reject all symlinks/hardlinks, then `tar -xzf --no-overwrite-dir --no-same-owner --no-same-permissions`. Make `.sha256` mandatory (no silent skip). One-time effort: also add `cosign verify` if signature asset present (warn-only this phase).
4. **MCP HTTP body cap** — `request.headers.get('content-length')` rejection at >1 MB; streaming read for unknown length, abort at 1 MB.
5. **MCP browser-origin default-deny** — when `--allow-origin` empty, `Origin` header presence ≡ reject. Native clients (no `Origin`) still pass. Loopback origins pass. *This is the one non-loopback change that's cheap and doesn't compromise public access — it only blocks third-party browser tabs from driving the MCP, which serves no legitimate use case.*
6. **`PRAGMA foreign_keys = ON`** — set on every connection open in `database.js` and reader-pool worker. Add a one-shot `apple-docs storage check-orphans` to surface existing FK violations before the next migration; do not auto-delete.
7. **`renderFontText` text length cap** — 256 chars, hard. Same for SF Symbol cache key fields (size/weight/scale/color allowlist).

### File-size targets to land this phase
- `src/commands/update.js` deleted (-475).
- `src/mcp/http-server.js` stays ≤400 (already 397; the body-cap helper goes in `src/lib/http-body.js`).

### Success criteria
- All Critical items in audit table closed.
- `bun test --isolate` ≥ 1300 tests pass; coverage ≥ 80%.
- New `bun run lint:size` script wired into CI; reports current 20 offenders as exempt.
- `apple-docs --help` lists `snapshot`, `consolidate`, `index`.

### Test gates
- Add: snapshot-tar-traversal fixtures (3 hostile archives: `..` member, absolute path, symlink-then-write).
- Add: graceful-shutdown integration test (SIGTERM under load, all in-flight settle within 30 s).
- Add: MCP origin matrix (`Origin: null`, missing, `http://localhost`, `http://evil.com`) — first three pass, last rejects 403.

---

## Phase 2 — Crack Open `database.js`, Fix What's Inside (5-6 days)

The 2147-LOC god module hides 8 distinct concerns and 20+ silent `catch{}`. Decompose, fix the bugs that the decomposition exposes, land the perf wins.

### Goals
- `database.js` ≤ 400 LOC (becomes a facade re-exporting from repos).
- All silent `catch{}` blocks in storage replaced with logged `safeCall` or removed.
- Two of the three perf cliffs eliminated.
- `commands/search.js` ≤ 400 LOC.

### Decomposition target

```
src/storage/
  database.js                 (facade, ~200 LOC: open, migrate, expose repos)
  pragmas.js                  (~60 LOC: WAL, mmap, FK, sync, cache)
  migrations/
    index.js                  (runner, ~100 LOC)
    v01_init.js … v13_*.js    (one file per migration; mostly already small)
    v14_pages_kill.js         (NEW — kill pages + refs, deferred to Phase 4)
  repos/
    documents.js              (~350 LOC)
    roots.js                  (~150 LOC)
    crawl.js                  (~200 LOC)
    search.js                 (~400 LOC: 4-way query planner)
    render-index.js           (~100 LOC)
    operations.js             (activity log + sync checkpoint, ~150 LOC)
    assets-fonts.js           (~120 LOC)
    assets-symbols.js         (~150 LOC)
  fts-query-builder.js        (~80 LOC)
  fuzzy-trigram-cache.js      (~150 LOC, see perf below)
```

### Security/perf/reliability bundled with this refactor

1. **Replace silent `catch{}` (49 sites total — most are in this module).** Land `src/lib/safe-call.js` first (`safeCall(fn, { default, log: 'warn'|'silent', label })`). Do *not* mass-rewrite — at each site, decide: is this a known-safe path that should warn-once-per-process? Or a real failure that should propagate? In particular: `searchTrigram`, `searchBody`, `getBodyIndexCount`, snippet enrichment must propagate, not return `[]`. Returning `[]` on FTS5 parse error silently degrades search quality — that's a correctness bug masquerading as resilience.
2. **Switch `documents_fts` and `documents_trigram` to `content='documents'`** — schema migration v14a, halves FTS storage and trigger cost. This is a long migration on a 350K-doc corpus (~45 s VACUUM); document the operator note.
3. **Move `_trigramCache` into SQLite** — replace `lib/fuzzy.js` module-level `Map` with a `documents_trigram_lookup` table populated by trigger. Eliminates 600-1200 MB cross-worker memory duplication. We have 64 GB RAM so this is not strictly necessary, *but* it also fixes the staleness bug (cache held forever in long-lived MCP HTTP processes) which is correctness, not memory.
4. **Per-result `JSON.parse` dedup** — parse `platforms_json` once per row in the search SELECT, not per dedup tier. ~30% reduction in search cascade CPU.
5. **Drop `searchTitleExact`** — collapse into the single search planner now that it's its own module.
6. **AbortSignal threaded through `lib/semaphore.js` + `lib/pool.js` + `lib/fetch-with-retry.js`.** Optional `signal` param; on abort, reject queued waiters and propagate to in-flight `fetch`. Wire into web request handlers (`Bun.serve` exposes `req.signal`).
7. **`commands/search.js` decomposition** — split into `search/cascade.js` (relaxation tiers), `search/filters.js` (kind/version/source predicate), `search/format.js` (result formatter). 559 → ~3×190.

### File-size targets
- `database.js`: 2147 → ≤300 (facade)
- `commands/search.js`: 559 → ≤200 (3 modules ≤200 each)
- Net offender count: 20 → 17

### Success criteria
- All ~70 prepared statements live exactly one place (per-repo `_prepare()`).
- No `catch (_) {}` or `catch (err) { return [] }` left in `src/storage/`.
- Full test suite + mutation tests on `repos/search.js` (Stryker score ≥ existing baseline).
- Search latency benchmark (`bun run bench`) regression ≤ 5 %.

### Test gates
- Add: per-repo unit tests with in-memory `:memory:` DBs.
- Add: a "schema fixture" test that opens a fresh DB at v0 and runs migrations 1→14, asserting row counts are preserved.
- Add: golden FTS5 query test (50 hand-picked queries, snapshot-stable result IDs+ordering — catches ranker regressions).

---

## Phase 3 — Web Rendering & Response Path (6-7 days)

This is where the user-facing latency lives. Three big files (`templates.js`, `apple-assets.js`, `build.js`) plus the gzip cliff.

### Decomposition targets

```
src/web/templates/
  document-page.js
  framework-page.js
  index-page.js
  search-page.js
  fonts-page.js
  symbols-page.js
  not-found-page.js
  shared/
    head.js, header.js, footer.js, escape.js, role-labels.js
    enrich-topic-items.js   (with the mutation bug fixed via clone)
    icons.js                (the 3 inline SVGs, deduped)

src/resources/
  swift-runner.js                 (Bun.spawn + mkdtemp helper)
  swift/
    symbol-render.swift           (ex SYMBOL_WORKER_SCRIPT)
    symbol-pdf.swift              (ex SYMBOL_PDF_SCRIPT)
    font-render.swift
  fonts/
    sync.js, sfnt.js, render.js
  symbols/
    sync.js, render.js, cache-key.js
src/lib/plist.js                  (extracted parseXmlPlist)

src/web/build/
  index.js                        (orchestrator, ~150 LOC)
  assets.js                       (Bun.build entry-point fan-out)
  static-pages.js                 (404, llms.txt, robots.txt, search index)
  document-pages.js
  framework-pages.js
  worker-fanout.js                (the bin-packing partitioner)
  checkpoint.js                   (manifest cache-busting, render-index)
  atomic-swap.js
```

### Security/perf/reliability bundled

1. **Stop the gzip cliff** (highest single TTFB win):
   - Static doc pages → already precompressed at build, served by Caddy. Verify with `curl -H 'Accept-Encoding: br'` smoke test.
   - Dynamic responses (search, on-demand docs) → switch from `Bun.gzipSync` to either `CompressionStream` (streams response, doesn't buffer) or skip compression for dynamic responses entirely if Caddy is in front. **Recommend skip; let Caddy handle it.** Saves the most CPU and the project is CPU-constrained.
2. **Per-key invalidation** — `invalidateDocumentCaches(key)` instead of `invalidateDocumentCaches()` everywhere in `routes/docs.route.js`. Render-cache triple-index invalidates only the affected key (and its known parents). This is the single biggest UX cliff.
3. **`renderFontText` and SF symbol render hardening** — text length cap (already in P1), parameter allowlist (P3 here): size ∈ {8,12,16,20,24,32,48,64,96,128}, weight ∈ {ultralight…black}, scale ∈ {small,medium,large}, color via 6-char hex regex. Anything else → 400. LRU+TTL on the persistent render cache (default 30 d, 5 GB cap — disk is plentiful but unbounded growth is an availability bug).
4. **Swift renderer temp scripts** — replace `process.pid` paths with `mkdtempSync()` in the new `swift-runner.js`. Fixes the predictable-symlink race.
5. **Per-IP rate limit on web** — `src/web/middleware/rate-limit.js` token-bucket keyed on `X-Forwarded-For || remoteAddr`, default 60 req/s burst 120, with a `--rate-limit` flag to tune. Apply to *all* routes; this is the open-access-friendly equivalent of "lock it down". Heavier limits on the SSRF-amplifier route (`docs` on-demand fetch): 5 req/min per IP.
6. **`enrichTopicItems` mutation bug** — defensive clone (`structuredClone`) before mutation; keep the by-doc cache in `web/build.js`.
7. **`render-cache.js` triple-index → on-demand prepared SELECTs.** Remove the in-memory index; query the DB. Per-request cost negligible (mmap), per-process memory savings 100-200 MB × N workers.

### File-size targets
- `templates.js`: 1566 → 0 (deleted; 8 page files ≤200 each + `shared/` of 5-6 files ≤150 each)
- `apple-assets.js`: 1499 → 0 (deleted; 8 files ≤200 each)
- `build.js`: 896 → ≤180 (orchestrator only)
- `symbol-pdf-to-svg.js`: 487 → ≤300 (extract `bytesToLatin1`, `inflate-helper`)
- Net offender count: 17 → 8

### Success criteria
- Full doc page TTFB (p50, dynamic path) ≤ 80 % of current.
- No `process.pid`-only temp paths left under `src/resources/`.
- Per-IP rate-limit smoke test (1000 req/s from one IP gets 429s; from 10 IPs all pass).

### Test gates
- Add: golden HTML snapshot tests for each `templates/*-page.js` (10 fixture pages each, deterministic output).
- Add: Swift-runner integration test (concurrent renders don't collide).
- Add: SSRF-amplifier rate-limit test.
- Manually verify in browser: doc page, framework page, search page, symbols, fonts.

---

## Phase 4 — Content Pipeline + Sources + Domain Model (7-8 days)

The longest phase. Touches the riskiest parsers (`parse-html.js`, `render-html.js`, `normalize.js`) and the half-finished `pages → documents` migration.

### Decomposition targets

```
src/content/
  normalize/
    index.js                    (~120 LOC: orchestrator)
    sections/
      paragraph.js, code-listing.js, links.js, table.js, declaration.js,
      parameters.js, term-list.js, hero.js, …                (one per kind)
    coercion.js                 (the 22 ?? section_kind sites consolidated here)
  render-html/
    index.js                    (~150 LOC)
    sections/                   (mirror of above)
    markdown.js                 (the hand-rolled converter; flagged for replacement in Phase 6)
  parse-html/
    text-extract.js
    docc-meta.js
    strip-elements.js           (with O(N²) loop replaced — see below)
```

`sources/wwdc.js` (714) → split into `wwdc/{discover,session,transcript,assets}.js`.
`sources/packages.js` (522) → split into `packages/{discover,readme,manifest,assets}.js`.
`commands/consolidate.js` (438) → split per consolidation pass.

### Security/perf/reliability bundled

1. **`stripElements` O(N²) → linear single-pass.** The `do…while` regex-replace loop is exploitable on a malicious or malformed source. Replace with a single tag-stack walk in `strip-elements.js`. Bonus: covers the `markdownToHtml` infinite-loop (`### `) class of bugs — add a regression test fixture.
2. **Schema migration v14: kill `pages` + `refs`.** This is the half-finished one. `getPage()` returns polymorphic shapes today; after this migration, only `documents` remains. Process: (a) migration copies any pages-only rows into documents with `status='legacy'`; (b) drop `pages`, `refs`, `document_relationships`; (c) `getPage()` becomes `getDocument()`; (d) update 60+ call sites. Canary: run the migration on a snapshot copy first, diff search results against pre-migration baseline.
3. **Per-source extension tables** — `wwdc_session_meta(doc_id, year, track, speakers, duration)` joined when filtering. Removes the 1000-row JS post-filter cap that silently truncates. Same pattern for `swift_evolution_meta(doc_id, proposal_number, status, review_period)` and `apple_archive_meta(doc_id, year, archive_section)`.
4. **Collapse 4-way kind taxonomy** — pick `documents.kind` as canonical (string), drop `role`, `role_heading`, `doc_kind` columns; backfill from current values. `matchesKindFilter` becomes a single SQL predicate.
5. **`platforms` extraction** — replace `min_ios/min_macos/min_watchos/min_tvos/min_visionos` columns with a `document_platforms(doc_id, platform, min_version, beta)` table. Numeric version comparison in SQL becomes correct (today's lexicographic `9.0 <= 10.0` bug fixed). 10 search predicate copies collapse to one JOIN.
6. **Source-type literals** → `src/sources/types.js` enum + freeze. Validation at boundary.
7. **Typed errors** → `src/lib/errors.js` with `UpstreamMissError`, `UpstreamRateLimitError`, `ParseError`, `BackpressureError`. Replace `message.startsWith('Not found:')` classification with `instanceof`.
8. **`fetchWithRetry` retry classification** — only retry on network/timeout; surface JSON-parse / DNS / HTTP 4xx (non-429) as terminal. Honor GitHub secondary rate limit (`403 + Retry-After` and `403 + X-RateLimit-Remaining=0`). Retry budget (max 3 per request, max 100/s globally).
9. **Per-key promise lock around `persistFetchedDocPage`** — prevents the backup-restore race.
10. **`update.js` was retired in Phase 1**, but if `sync` does single-404 tombstoning, switch to N=3 consecutive 404s.

### File-size targets
- `normalize.js`: 964 → 0 (orchestrator + 12-15 section files ≤120 each)
- `render-html.js`: 918 → 0 (mirror)
- `parse-html.js`: 732 → 0 (3 files ≤300 each)
- `wwdc.js`: 714 → 4 files ≤200 each
- `packages.js`: 522 → 4 files ≤150 each
- `consolidate.js`: 438 → 3 files ≤180 each
- `symbols-page.js` (web asset): 695 → split into `symbols-page/{index,filters,grid,detail-panel}.js` ≤200 each
- `collection-filters.js`: 469 → 2 files
- `tree-view.js`: 435 → 2 files
- `cli/formatter.js`: 424 → split per output kind
- `guidelines-parser.js`: 417 → split per section type
- Net offender count: 8 → 0 ✓

### Success criteria
- **All source files ≤ 400 LOC.** CI gate flips from warning-with-exempt-list to hard error.
- `pages` and `refs` tables gone.
- Lexicographic version-filter bug closed (regression test: search "iOS 9" vs "iOS 10").
- WWDC year-filter no longer silently truncates at 1000 rows.
- Mutation testing score on `content/render-html/` ≥ 80 %.

### Test gates
- Add: pre/post snapshot diff for migration v14 on a real corpus (manual gate before merging).
- Add: property-based tests via `fast-check` for `parse-html` and `render-html` (well-formed-in → escaped-out invariants).
- Add: WWDC year=2024 filter returns ≥ N expected sessions where N > 1000.
- All ≥1300 existing tests still pass.

---

## Phase 5 — Observability, MCP Polish, Type Safety (4-5 days)

Now that the topology is clean, layer in the things that need a clean topology to make sense.

### Goals
- Every long-running process is observable.
- MCP tool surface conforms to current SDK best practices.
- Strict type-check rolling out.
- Last LOC offenders (`mcp/server.js`, `mcp/pagination.js`) closed.

### Decomposition
- `mcp/server.js` (566) → `mcp/server.js` (registration, ~150) + `mcp/tools/{search-docs,read-doc,browse,frameworks,kinds,doctor,assets,symbols}.js` ≤120 each.
- `mcp/pagination.js` (534) → `pagination/{cursor,window,segment-too-large}.js`.

### Bundle
1. **`outputSchema` + tool annotations** on all 11 MCP tools. SDK 1.29 accepts `{ outputSchema, annotations: { readOnlyHint: true, idempotentHint: true } }`. Massive LLM-affordance lift for ~50 LoC of zod per tool.
2. **OpenTelemetry** — `@opentelemetry/api` + OTLP HTTP exporter (off by default, env-flag `APPLE_DOCS_OTEL_ENDPOINT`). Wrap: HTTP request, MCP tool call, DB query (top-level), reader-pool dispatch. Spans only, no metrics yet.
3. **Prometheus `/metrics`** on web server (off by default, env-flag). Export the counters that already exist: `mcp/cache.js` hits/misses/stamps, semaphore wait/active/queued, reader-pool worker health, fetch retry counts, FTS query latency histogram. Existing observability work is 80 % done — this just exposes it.
4. **`/readyz`** that touches DB and reader-pool, distinct from `/healthz` (liveness).
5. **Correlation IDs** — `X-Request-Id` echo + propagate through logger child-context. Adopt `pino`-style child loggers in `lib/logger.js`.
6. **`checkJs: true` rolling adoption** — flip the tsconfig flag with a `// @ts-nocheck` shim at top of every existing `.js`, then strip the shim file by file starting with: `repos/documents.js`, `repos/search.js`, `mcp/server.js`, `web/context.js`. Target: Phase 5 finishes with 30 % of source under strict check; Phase 6 carries the rest.
7. **`bun audit` blocking in CI** — fix the 9 transitive advisories (upgrade `@modelcontextprotocol/sdk`, `@stryker-mutator/core`).
8. **`SECURITY.md` + GitHub Scorecard + CodeQL workflow.**

### Success criteria
- `apple-docs mcp serve --otel http://…` produces traces; `--metrics-port 9090` serves Prometheus.
- All 11 MCP tools have `outputSchema`.
- 30 % of `src/` strict-type-checked.
- `bun audit` clean.

### Test gates
- MCP contract test: every tool's response validates against its declared `outputSchema`.
- OTEL smoke: in-memory exporter receives ≥ N spans for a known workload.
- Prometheus scrape returns valid format.

---

## Phase 6 — SOTA & Polish (open-ended; 1-2 sprints when picked up)

Lower priority. None of these are correctness or security, but they're where the project's LLM-affordance ceiling currently sits.

- **Embedding index** — MiniLM-L6 over `(title + abstract)`, ~100 MB index in `sqlite-vec`. Hybrid `search_docs` reranks with semantic score after lexical cascade. Single biggest LLM-affordance lift on top of everything above.
- **Replace hand-rolled markdown** in `render-html/markdown.js` with `micromark` (CommonMark spec, ReDoS-hardened). Behind a feature flag, A/B against current renders, swap when diff is acceptable.
- **Replace hand-rolled HTML parser** with `linkedom`. Bigger blast radius; gate behind an extended test corpus.
- **`checkJs` rollout to 100 %.**
- **Playwright e2e** on web UI — search interactions, symbol gallery filters, font preview.
- **SLSA provenance** — `actions/attest-build-provenance` on release artifacts; `cosign sign-blob` snapshot tarballs; verify on `apple-docs setup`.
- **Windows binary + Homebrew formula + macOS notarization.**
- **`npm publish --provenance`** when publishing.

---

# Code-Quality Enforcement Mechanism

The 200-400 LOC ceiling is the constraint. Concrete mechanism:

1. **`scripts/check-file-size.js`** — runs in CI, reads `.file-size-budget.json`:
   ```json
   {
     "max_lines": 400,
     "soft_target": 300,
     "exempt": [
       "src/storage/database.js",
       "src/web/templates.js",
       …
     ],
     "exempt_expires_phase": "P4"
   }
   ```
   Fails CI if: any non-exempt file exceeds 400, OR any exempt file *grows*. The exempt list is the offender list at start of Phase 1; each phase deletes entries from it. Phase 4 success criterion is the empty exempt list.

2. **Biome `noUselessFragments` + `noUselessElse` + the existing `noUnusedImports`** stay on as soft style nudges. Biome 2.x has no first-class line-count rule, hence the custom script.

3. **`bun run lint:duplication` (jscpd)** stays at the current threshold (33 clones / 361 lines). Tighten by 25 % at end of each phase: P1 → 27 clones, P2 → 20, P3 → 15, P4 → 10.

4. **Pre-commit hook** (`.husky/pre-commit` or a `bun-pre-commit` equivalent) runs `lint:size` + `biome check --staged`. Optional but recommended.

5. **PR-template checkbox**: "Files touched: all under 400 LOC after this change."

The 200-LOC *target* is aspirational — single-purpose helper modules should aim for it; coordinator/orchestrator modules can sit at 200-400; nothing exceeds 400.

---

# Security Re-Prioritization (open-access constraint)

The audits assumed a private/auth'd deploy. Several recommendations need reshaping to match "must remain publicly accessible":

| Audit said | Status | Reshape |
|---|---|---|
| Default web bind to `127.0.0.1` | **Downgraded** | Keep `0.0.0.0`. Add per-IP token-bucket rate limit (60 req/s burst 120). Add 1 MB body cap. The threat the bind-localhost rec addresses (LAN exposure) is the *intent* of this project. |
| Require auth on MCP HTTP | **Downgraded** | Keep auth-free for now. Default-deny browser `Origin` (Phase 1) blocks cross-site browser attacks; native MCP clients still pass. Loopback-only auth would defeat the point. |
| Lock down render endpoints behind auth | **Reshaped** | Keep public. Cap text length, allowlist parameters, LRU+TTL the render cache, per-IP rate-limit the SSRF-amplifier route at 5 req/min/IP. Disk is plentiful so 5 GB cache cap is generous. |
| "Unauthenticated render = DoS vector" | **Reshaped** | Same as above: bound the work, don't gate the access. |
| Disable on-demand fetch in public deployments | **Reshaped** | Keep on. Per-IP 5 req/min, negative-cache misses for 24 h, bounded queue (drop with 503 not buffer). |
| Stack-trace leakage in errors | **Kept** | Strip stacks in production responses; this is information disclosure with no UX cost. |
| HTTPS-only / HSTS | **Kept; Caddy concern** | Edge concern, document in `docs/self-hosting.md`. |
| CSP | **Kept; Phase 5** | Inline 404 script needs to move to a hashed external; then `script-src 'self' 'sha256-…'`. |

The principle: **bound the work per request, bound the work per IP, never gate the read path.**

---

# Risk Register

Highest-risk refactors and their mitigations.

| # | Refactor | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| R1 | `database.js` decomposition (P2) | Prepared-statement scope leak; subtle ranking regression | M | H (search quality cliff) | Golden 50-query FTS test (added in P2). Mutation testing on `repos/search.js`. Staged rollout: facade re-exports old API exactly; one repo per commit. |
| R2 | Migration v14 (kill `pages` + `refs`) | Data loss for any pages-only rows | L | **Critical** | Pre-migration snapshot. Migration runs in transaction. Pre/post diff gate on row counts and a sample of `SELECT * FROM documents WHERE …`. Canary on a snapshot copy first. |
| R3 | `documents_fts` → external-content (P2) | FTS5 trigger edge cases, doubled storage during cutover | L | M | One-shot migration during low-traffic window. Verify `SELECT count FROM documents_fts` matches `SELECT count FROM documents` before and after. Keep the rollback migration scripted. |
| R4 | `render-html.js` decomposition (P4) | Per-section rendering subtle text differences | M | M (UX cliff) | Golden HTML snapshot tests per section kind (P3). Manual diff of 100 random rendered pages. |
| R5 | Property-based tests on parsers (P4) | `fast-check` finds latent bugs that block the phase | M | L (good problem) | Time-box P4 by 1 day for triage; defer non-blocking findings to P6. |
| R6 | `gzipSync` removal (P3) | Caddy not configured for compression in some deployments | L | M (bigger payloads) | Document the Caddy config requirement; smoke test `Content-Encoding: br` end-to-end. |
| R7 | AbortSignal threading (P2) | Cancellation propagation deadlocks | M | M | Add a "cancel under load" integration test; review every `await` site for `signal.throwIfAborted()`. |
| R8 | `outputSchema` on MCP tools (P5) | Existing clients reject newly-strict responses | L | M (MCP contract regression) | Run the in-memory MCP contract test against each tool before merging. Schemas are *describing* current responses, not changing them. |
| R9 | Per-IP rate limit (P3) | Shared NAT (school, corporate) hits limits | M | M (UX) | Generous defaults (60/s burst 120). Make tunable via flag. Document. Allowlist a configurable CIDR via flag. |
| R10 | Strict `checkJs` rollout (P5) | Dozens of latent type errors block CI | H | M (slow) | `// @ts-nocheck` shim per file; convert one file per commit; track progress via `scripts/typecheck-coverage.js`. |
| R11 | Embedding index (P6) | First-load CPU spike (model load) on CPU-constrained host | M | M | Lazy-load model on first semantic query; cap concurrent inference at 2; expose `--no-semantic` flag. |

---

# Schedule Summary

| Phase | Effort | Calendar (1 committer) | Cumulative offenders left | Cumulative new tests |
|---|---|---|---|---|
| P1 — Stop the bleeding | 3-4 days | Week 1 | 20 → 19 | +6 |
| P2 — `database.js` + search | 5-6 days | Week 2 | 19 → 17 | +12 |
| P3 — Web rendering + response | 6-7 days | Week 3 | 17 → 8 | +20 |
| P4 — Content + sources + domain | 7-8 days | Weeks 4-5 | 8 → 0 ✓ | +25 |
| P5 — Observability + MCP polish | 4-5 days | Week 6 | 0 | +15 |
| P6 — SOTA & polish | open | post | 0 | +Playwright suite |

**Total to "all files ≤ 400 LOC + every Critical/High audit item closed":** ~5-6 weeks (P1-P4).
**Total to "production-grade for multi-tenant LLM-facing public MCP":** +1 week (P5).
