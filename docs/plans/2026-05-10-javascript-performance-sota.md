# Implementation plan — JavaScript performance SOTA

**Source:** `docs/research/2026-05-10-javascript-performance-sota.md`
**Date:** 2026-05-10

## Context

The research doc identifies five high-leverage perf fronts: split cheap from expensive search, replace `pool()` queue mechanics, mirror MCP's metrics surface on web, reduce structured-clone payload sizes, and treat JIT friendliness as a discipline. The clear ordering is:

1. **Measurement first** — without web-side metrics + a mixed-load benchmark we can't validate any subsequent optimization.
2. **Tail-latency isolation** — the doc's data shows fuzzy/body work pushing SLO p99 from ~5 ms to ~1968 ms when sharing the reader pool. This is the highest-confidence user-facing win.
3. **Memory + worker payload reduction** — needs profile-driven evidence first, deferred.
4. **JIT shape hygiene** — same; deferred.

This plan executes phases 1 + 2 in one PR (mechanical + measurable). Phases 3 + 4 land later, gated on the perf workflow that phase 1 establishes.

## Scope

**In this PR (phases 1 + 2):**

| | Item | Rationale |
|---|---|---|
| 1.1 | Web `/metrics` provider mirroring MCP's | Without it we cannot tell whether phase 2 helped |
| 1.2 | Event-loop lag sampler + RSS/heap gauges (web + MCP) | Catches future regressions, especially around `gzipSync` paths |
| 1.3 | Replace `pool()` queue `shift()` with index cursor | Mechanical, zero-risk, removes O(n²) on 345k-item builds |
| 1.4 | Mixed-load benchmark (SLO + fuzzy/body) | Locks in the regression surface before phase 2 |
| 2.1 | Two reader pools: `strict` (FTS/trigram/exact) + `deep` (fuzzy/body) | Eliminates head-of-line blocking |
| 2.2 | Per-operation deadlines | Already partly in `reader-pool.js`; surface as per-op overrides |
| 2.3 | Partial-results-on-deep-timeout in the search cascade | UX: title results never wait for body |
| 2.4 | Per-route gate for deep search | One client cannot saturate the deep pool |
| 2.5 | Perf-workflow scaffolding under `docs/perf/` | Bun `--cpu-prof` / `--heap-prof` invocation, baseline files |

**Deferred to follow-up PRs:**

- **Phase 3** — slim worker messages (IDs/scores), shared-or-persisted fuzzy index, browser worker `Set` → typed arrays, heap snapshot diffing.
- **Phase 4** — DB row → result-object normalization in one pass, packed arrays, hot-path object spread cleanup, JIT shape audits.

These need the metrics + benchmarks from phase 1 to validate. Doing them blind would risk regressions we can't see.

## Phase 1 — measurement foundation + one mechanical fix

### 1.1 Web metrics provider

**New file:** `src/web/metrics-provider.js` (mirrors `src/mcp/metrics-provider.js`'s shape)

Exports `maybeStartWebMetricsServer(opts, deps)` with the same signature pattern. Deps: `{ logger, serve?, readerPool, rateLimiter, searchCache, renderCache, gzipCache, eventLoopLag, processGauges }`.

Metrics emitted (mirror Prometheus naming convention already established in MCP):

| Metric | Type | Labels | Source |
|---|---|---|---|
| `apple_docs_web_search_requests_total` | counter | `mode,cache,deep,fuzzy` | `src/web/routes/search.route.js` |
| `apple_docs_web_search_latency_ms_bucket` | histogram | `tier` | search.route.js + `src/commands/search.js` |
| `apple_docs_web_reader_pool_pending` | gauge | `op` | new per-op tracking in reader-pool |
| `apple_docs_web_reader_pool_timeouts_total` | counter | `op` | reader-pool |
| `apple_docs_web_search_cache_bytes` | gauge | — | `searchCache.byteSize?.()` |
| `apple_docs_web_render_cache_bytes` | gauge | — | `renderCache.byteSize?.()` |
| `apple_docs_web_gzip_cache_bytes` | gauge | — | `gzipCache.byteSize?.()` |
| `apple_docs_web_event_loop_lag_ms` | gauge | `quantile` (p50/p95/p99) | new sampler |
| `apple_docs_process_rss_bytes` | gauge | — | `process.memoryUsage().rss` |
| `apple_docs_process_heap_bytes` | gauge | `kind` (used/total) | `process.memoryUsage()` |

Histograms need a small client. Simplest: a fixed bucket array `[1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500]` ms, recorded per request and exported as `_bucket{le="5"}` cumulative. Add `src/lib/histogram.js` (~40 LOC).

**Files modified:** `src/web/serve.js` (replace `buildWebMetrics` with new provider call site), `cli.js` (already has `metricsOpts`, no change), `src/web/middleware/observability.js` (new — wraps each route with timing + counter increments).

**Tests:** `test/unit/web-metrics-provider.test.js` — assert format + label correctness, mirror existing MCP metrics test shape.

### 1.2 Event-loop lag sampler + process gauges

**New file:** `src/lib/event-loop-lag.js`

Cross-runtime sampler. On Node, prefer `perf_hooks.monitorEventLoopDelay({ resolution: 10 })` and call `.percentile(50/95/99)`. On Bun, fall back to a `setInterval(..., 100)` drift sampler using `Bun.nanoseconds()` (or `performance.now()`) — store the last 600 samples in a ring buffer, compute percentiles on read.

API: `createEventLoopLagSampler({ intervalMs?: number }) → { stop(), snapshot(): { p50, p95, p99, samples } }`.

`createWebContext` and `startHttpServer` (MCP) both wire it into their metrics deps. `lifecycle.register({ name: 'event-loop-lag', stop })` so it tears down cleanly.

Process gauges piggyback on the same sample tick: read `process.memoryUsage()` once per snapshot.

**Tests:** `test/unit/event-loop-lag.test.js` — fake timers, assert percentile semantics on a known sample sequence.

### 1.3 Replace `pool()` queue mechanics

**File:** `src/lib/pool.js` (60 LOC currently)

Current:
```js
const queue = [...items]
// ...
const item = queue.shift()  // O(n) per dequeue
```

Rewrite to index cursor:
```js
let cursor = 0
// ...
const item = items[cursor++]
```

Saves the array copy and replaces O(n) `shift()` with O(1) index increment. For 345k-item builds this removes a ~10–30 s scheduler tax.

Subtleties: abort path now sets `cursor = items.length` instead of `queue.length = 0`. The pre-existing `aborted` settle path stays.

**Tests:** `test/unit/pool.test.js` — already exists; add a 100k-item ordering test that exercises cursor mechanics + abort.

### 1.4 Mixed-load benchmark

**New file:** `test/benchmarks/search-mixed-bench.js`

Modeled on `search-real-bench.js`. Two pools of queries:
- `slo` (~80%): default-mode title/path searches from the existing fixture.
- `heavy` (~20%): explicit fuzzy + deep + body searches.

Concurrency sweep: `1, 4, 8, 16`. Output assertions:
- `slo.p99 < 50 ms` at concurrency=8 even when `heavy` is active.
- `slo.p99 < 100 ms` at concurrency=16.

Threshold values come from current measurements — tune after first run on the dev box.

This benchmark is the regression gate for phase 2.

### 1.5 Perf workflow

**New file:** `docs/perf/README.md` documenting the canonical commands:

```bash
bun --cpu-prof --cpu-prof-dir reports/profiles bun cli.js web serve --port 3030
bun --heap-prof --heap-prof-dir reports/profiles bun cli.js mcp serve --port 3031
bun test/benchmarks/search-mixed-bench.js --concurrency 1,4,8,16 --record
```

Add to `.gitignore`: `reports/profiles/`. Add `bun run perf:cpu`, `bun run perf:heap`, `bun run bench:mixed` to `package.json` scripts.

## Phase 2 — tail-latency isolation

### 2.1 Split reader pools

**File:** `src/storage/reader-pool.js`

Today: one pool, default size = `availableParallelism() - 2`, cap 12.

After: two pools, separate worker pools sharing the same worker module:
- `strictPool` — for FTS / trigram / exact / title-prefix lookups. Size = `max(1, availableParallelism() - 4)`, cap 12.
- `deepPool` — for `searchBody`, `fuzzyMatchTitles`, body snippet enrichment. Size = `max(1, floor(availableParallelism() / 4))`, cap 4.

API:
```js
createReaderPools(opts, deps) → {
  strict: ReaderPool,
  deep: ReaderPool,
  close({ softDrainMs }),
  recycle(),
  stats(),  // returns both pools' stats
}
```

The existing `createReaderPool` stays as the worker primitive. The new factory layers two on top.

**File:** `src/storage/reader-pool-classifier.js` (new, ~30 LOC)

Maps an op name → which pool to use:
```js
const DEEP_OPS = new Set(['searchBody', 'searchBodyAndEnrich', 'fuzzyMatchTitles', 'getBodyIndexCount'])
export function classifyOp(op) { return DEEP_OPS.has(op) ? 'deep' : 'strict' }
```

**Files modified:** `src/web/context.js`, `src/mcp/http-server.js` — both go from `readerPool` to `readerPools = { strict, deep }`. Lifecycle stop closes both.

`runRead(op, args)` becomes:
```js
const target = classifyOp(op) === 'deep' ? readerPools.deep : readerPools.strict
return target.run(op, args, opts)
```

This is the load-bearing change for the whole phase.

**Tests:** `test/unit/reader-pool-split.test.js` — start a deep+strict pair, blast strict with 100 fast ops while deep is held by an artificially-slow `searchBody`. Assert strict p99 stays low.

### 2.2 Per-operation deadlines

**File:** `src/storage/reader-pool.js`

Existing `defaultDeadlineMs = 5000` already lives here. Surface it as a per-op map:

```js
const PER_OP_DEADLINE_MS = {
  searchTitleExact: 100,
  searchTrigram: 200,
  searchPages: 250,           // FTS
  fuzzyMatchTitles: 750,
  searchBody: 2000,
  searchBodyAndEnrich: 2500,
  // default: 5000
}
```

`pool.run(op, args, opts)` resolves the deadline as `opts.deadlineMs ?? PER_OP_DEADLINE_MS[op] ?? defaultDeadlineMs`.

Surfaces a `timeouts_total` counter per op (already lands in metrics from 1.1).

### 2.3 Partial-results on deep timeout

**File:** `src/commands/search.js`

The cascade currently calls `searchBody` / `fuzzyMatchTitles` inline. After the split, these dispatches go to `readerPools.deep`. Wrap each in a `try/catch` that:
- On `BackpressureError` → log at `info` (expected), append a `partial: true` flag to the result envelope, skip the deep contribution.
- On per-op timeout → same behavior.
- Cheap strict results still return.

The result envelope already has a shape; the new field is optional and additive. The MCP `outputSchema` allows it (already permits `partial: boolean`; if not, augment that schema entry).

**Tests:** `test/unit/search-partial-on-deep-timeout.test.js` — inject a `readerPools.deep` stub that always times out, assert the response contains strict results + `partial: true`.

### 2.4 Per-route gate for deep search

**File:** `src/web/routes/search.route.js`

Add a small `Semaphore(N)` (where `N = max(1, deepPool.size * 2)`) gating only `deep=true` requests. Cheap requests bypass.

Reuses the existing `src/lib/semaphore.js` (with `maxWaiters` → 503).

This isolates hostile clients sending deep=true en masse from starving normal users — the deep pool stays available for legitimate explicit-deep requests from other clients.

### 2.5 Validation

After 2.1-2.4 are in:

```bash
bun test/benchmarks/search-mixed-bench.js --concurrency 1,4,8,16 --record
```

Expected delta (from research doc baseline):
- `slo.p99 @ concurrency=8` should drop from **~1968 ms → < 50 ms**.
- `heavy.p99 @ concurrency=8` may rise slightly (deep pool is smaller) but stays usable.

This is the smoke test for the whole phase. If it doesn't deliver, the split has a bug — not the design.

## Phase 3 + 4 — placeholder TOC for follow-up PRs

(Listed for completeness; not implemented in this PR.)

**Phase 3 — memory + worker payload reduction:**
- 3.1 Worker SQL returns `{id, score}` only; main-thread enriches once with `db.getBatchByIds(ids)`.
- 3.2 `_trigramCache` → SQLite `trigram_index(trigram, doc_id)` table; or one dedicated fuzzy worker; or a transferable `Uint32Array` postings list shipped at warmup.
- 3.3 Browser worker `Map<string, Set<number>>` → sorted `Uint32Array` postings + delta varint or a small Roaring-bitmap implementation. Build artifact published under `data/search/`.
- 3.4 Heap-snapshot diffing harness in `docs/perf/`.

**Phase 4 — JIT shape hygiene:**
- 4.1 `formatResult()` rewrite: stable property order, no spread, no late property additions. Same for browser worker scored result objects.
- 4.2 `parseRowPlatforms()` mutation removed — emit `platformsParsed` alongside `platformsJson` once at row-load, never mutate downstream.
- 4.3 Audit hot loops with Bun `--cpu-prof`; replace any spread with explicit constructor functions where the profile points.
- 4.4 Microbenchmarks for top three offenders only — no speculative refactors.

## Verification gates

Each phase ships only when:

| Gate | Phase 1 | Phase 2 |
|---|---|---|
| `bun run lint && typecheck && test --isolate` | ✅ required | ✅ required |
| `bun run lint:size lint:unused lint:duplication` | ✅ required | ✅ required |
| `bun audit` | ✅ required | ✅ required |
| `bun test/benchmarks/search-mixed-bench.js` records baseline | ✅ records | ✅ regresses ≤ 0% on `slo`, recovers `slo.p99` to < 50 ms |
| `/metrics` exposes new web counters/histograms (smoke) | ✅ required | — |
| Dev-server smoke: `/healthz`, `/readyz`, CSP, listen 127.0.0.1 | ✅ required | ✅ required |

## Critical files to be modified or created

| Phase | Path | Action |
|---|---|---|
| 1.1 | `src/web/metrics-provider.js` | **new** |
| 1.1 | `src/web/middleware/observability.js` | **new** |
| 1.1 | `src/lib/histogram.js` | **new** |
| 1.1 | `src/web/serve.js`, `src/web/context.js` | edit |
| 1.1 | `test/unit/web-metrics-provider.test.js` | **new** |
| 1.2 | `src/lib/event-loop-lag.js` | **new** |
| 1.2 | `src/web/serve.js`, `src/mcp/http-server.js` | edit |
| 1.2 | `test/unit/event-loop-lag.test.js` | **new** |
| 1.3 | `src/lib/pool.js` | edit |
| 1.3 | `test/unit/pool.test.js` | edit |
| 1.4 | `test/benchmarks/search-mixed-bench.js` | **new** |
| 1.5 | `docs/perf/README.md` | **new** |
| 1.5 | `package.json` (scripts) | edit |
| 1.5 | `.gitignore` | edit (`reports/profiles/`) |
| 2.1 | `src/storage/reader-pool.js` | edit (extract `createReaderPools` factory) |
| 2.1 | `src/storage/reader-pool-classifier.js` | **new** |
| 2.1 | `src/web/context.js`, `src/mcp/http-server.js` | edit |
| 2.1 | `test/unit/reader-pool-split.test.js` | **new** |
| 2.2 | `src/storage/reader-pool.js` | edit (per-op deadlines) |
| 2.3 | `src/commands/search.js` | edit (partial-results path) |
| 2.3 | `src/mcp/tools/docs.js` (outputSchema if needed) | edit |
| 2.3 | `test/unit/search-partial-on-deep-timeout.test.js` | **new** |
| 2.4 | `src/web/routes/search.route.js` | edit |

## Reused utilities (no reinvention)

- `src/lib/semaphore.js` — already supports `maxWaiters` → 503; phase 2.4 reuses.
- `src/mcp/metrics-provider.js` — phase 1.1 mirrors the shape (don't copy code; share `formatPrometheus` from `src/lib/metrics.js`).
- `src/lib/lifecycle.js` — sampler stop hooks plug in identically to existing servers.
- `src/lib/run-step.js` (just landed) — phase 2 deep-timeout wrapping uses it.
- Existing `BackpressureError` (`src/lib/semaphore.js`) — reused for both per-op classification and route-gate overflow.

## Risks

- **2.1 (split pools) doubles SQLite handle count.** Two pools × N workers × WAL handle = 2× file descriptors. Mitigation: cap deep pool at 4, and the strict pool already capped at 12. macOS default `ulimit 256` survives easily.
- **2.3 (partial results) changes API response shape.** New `partial: true` field is additive; clients that don't read it are unaffected. MCP schema must be updated; CLI formatter must surface a `(partial)` badge so users know.
- **1.1/1.2 metrics endpoint cost.** All gauges read on scrape, no per-request cost beyond one counter increment + one histogram bucket bump. Histogram bucket count is fixed (10 buckets); zero allocation per record.
- **1.3 pool index cursor** — straightforward; the only failure mode is forgetting to update the abort path. Test covers it.
- **Phase 2 needs the phase 1 benchmark to declare success.** If we ship phase 2 without 1.4, we're guessing at the win.

## Execution order

1.3 (mechanical) → 1.5 (docs/scripts) → 1.2 (sampler — no dependencies) → 1.1 (web metrics — depends on 1.2) → 1.4 (benchmark — depends on 1.1) → record baseline → 2.1 → 2.2 → 2.3 → 2.4 → re-run 1.4 → record gain.
