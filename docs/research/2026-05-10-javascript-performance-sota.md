# JavaScript Performance SOTA Recommendation Report

Date: 2026-05-10

Scope: `apple-docs` Bun/JavaScript codebase. The goal is maximum practical performance across memory, workers/threads, event-loop behavior, JIT friendliness, and current JavaScript/Web/Node/Bun APIs.

## Executive Summary

This codebase is already using several high-leverage performance patterns: SQLite FTS/trigram search, WAL+mmap pragmas, bounded reader workers, render/build fan-out, precompressed static output, browser-side search artifacts, and cache caps. The next stage is not "more JavaScript tricks"; it is tail-latency isolation, memory shape control, and measurement.

The most important runtime fact is that this package declares Bun as its engine. Bun uses JavaScriptCore, not V8. V8 internals still matter for Node and Chromium/browser paths, but production server advice must be validated on Bun/JSC first.

Highest priority recommendations:

1. Split cheap search from expensive deep/fuzzy/body work. Real-corpus benchmarks show default searches are fast, but body/fuzzy work can poison the shared reader pool and push unrelated SLO queries into second-scale tail latency.
2. Replace array `shift()` based generic pooling with an index cursor. `src/lib/pool.js` copies all items and shifts one item per task; at 345k documents this creates avoidable O(n) reindexing work per dequeue.
3. Add a web metrics surface equivalent to the MCP metrics surface: per-route latency histograms, reader-pool per-operation stats, cache bytes, RSS/heap/native memory, and event-loop lag.
4. Reduce structured-clone and cache payload sizes. Prefer IDs, compact rows, JSON strings, or transferable `ArrayBuffer`s over rich object graphs crossing worker boundaries.
5. Treat JIT friendliness as a coding discipline: stable object shapes, stable property assignment order, packed arrays, bounded polymorphism, no hidden large synchronous JSON/regex/compression work on request paths.

## Codebase Baseline

Runtime and local environment:

- Bun: `1.3.13`
- Node available locally: `v26.0.0`
- Default local corpus: `~/.apple-docs/apple-docs.db`, 3.6 GB, 344,995 `documents` rows
- Worktree was dirty before this report; benchmarks were run against the current local tree without recording benchmark history.

Lightweight synthetic benchmarks:

| Benchmark | Result |
| --- | --- |
| `bun test/benchmarks/search-bench.js` | p50 0.29 ms, p95 0.50 ms, p99 3.36 ms |
| `bun test/benchmarks/pipeline-bench.js` | p50 18.51 ms, p95 22.32 ms |
| `bun test/benchmarks/highlight-bench.js` | p50 0.00 ms, p95 0.26 ms, p99 0.68 ms |
| `bun test/benchmarks/seed-bench.js` | p50 10.91 ms, p95 13.63 ms |

Real-corpus search benchmark, direct mode, 4 reader workers, default SLO cases only:

| Concurrency | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| 1 | 0.62 ms | 5.01 ms | 5.52 ms |
| 4 | 0.86 ms | 6.42 ms | 7.34 ms |
| 16 | 4.79 ms | 14.90 ms | 21.02 ms |

Real-corpus `/api/search`, cache off, 4 reader workers, default SLO cases only:

| Concurrency | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| 1 | 1.08 ms | 5.36 ms | 5.74 ms |
| 4 | 1.52 ms | 6.58 ms | 7.54 ms |
| 16 | 6.93 ms | 17.57 ms | 22.00 ms |

Real-corpus direct mode with fuzzy and body cases included:

| Concurrency | SLO p95 | SLO p99 | All p95 | All p99 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 5.50 ms | 5.73 ms | 139.01 ms | 2531.01 ms |
| 8 | 231.26 ms | 1967.54 ms | 2098.71 ms | 2178.71 ms |

Interpretation: normal title/path search is within the current 25 ms p99 target. The risk is head-of-line blocking when expensive fuzzy/body operations share the same reader pool as cheap searches.

## Current Architecture Observations

Hot paths:

- Search cascade: `src/commands/search.js`
- SQLite search statements: `src/storage/repos/search.js`
- Reader worker pool: `src/storage/reader-pool.js` and `src/storage/reader-worker.js`
- Browser search worker: `src/web/worker/search-worker.js`
- Search artifacts: `src/web/search-artifacts.js`
- Web cache/context wiring: `src/web/context.js`
- Generic async concurrency pool: `src/lib/pool.js`
- Metrics foundation: `src/lib/metrics.js`, `src/lib/metrics-server.js`, `src/mcp/metrics-provider.js`

Strengths:

- SQLite query work can run off the main event loop via worker threads.
- Web search defaults to `fast` and `no_deep`, which keeps normal queries fast.
- Reader-pool backpressure, timeouts, and worker recycling exist.
- Search response cache now has a byte cap.
- Render and native work have semaphores and process deadlines in newer files.
- Browser search uses a Web Worker, keeping index work away from the UI thread.

Risk areas:

- Expensive `searchBody` and `fuzzyMatchTitles` share reader capacity with cheap FTS/trigram reads.
- `fuzzyMatchTitles` builds a per-process trigram cache from every title. With N workers, memory and warmup cost multiply by N.
- The generic `pool()` implementation uses `queue.shift()`, which is not appropriate for hundreds of thousands of items.
- Browser search builds `Map<term, Set<docIndex>>` and prefix sets, which is simple but memory-heavy.
- `finalizeResponse()` still performs synchronous hashing and optional `gzipSync()` on hashable dynamic responses.
- Web `/metrics` is not yet parallel to MCP `/metrics`.
- Many APIs accept `AbortSignal` at lower layers, but some pipeline callsites do not propagate the signal all the way to fetch and long work.

## JavaScript Runtime Internals That Matter

### JavaScriptCore/Bun First

Bun documents that it uses Apple's JavaScriptCore engine. JavaScriptCore has multiple JIT tiers and speculative optimization. WebKit's JSC documentation describes LLInt, Baseline JIT, DFG JIT, and FTL JIT, with higher tiers trading compile latency for throughput.

Practical consequence: optimize for stable hot code and avoid deoptimization triggers, but validate with Bun CPU/heap profiles. Do not assume a V8-only optimization wins on JSC.

### V8 Portability Guidance

For Node/Chromium paths, V8 uses hidden classes/maps, elements kinds, inline caches, and tiered JITs such as Sparkplug, Maglev, and TurboFan. The coding principles overlap with JSC:

- Keep object shapes stable.
- Initialize fields in the same order.
- Avoid `delete` and late property additions in hot objects.
- Avoid megamorphic functions that receive many unrelated object shapes.
- Keep arrays packed; avoid holes and out-of-bounds reads.
- Avoid mixing numeric/object/string payloads in the same hot arrays.

This matters in this repo for search result objects, DB row normalization, worker messages, browser search entries, and template view models.

Specific code smell to revisit: `parseRowPlatforms()` mutates `r.platforms` from string to object/null in `src/commands/search.js`. That is convenient, but in hot paths it mixes value representations for the same property. A more stable shape is either `platformsJson` plus `platformsParsed`, or a formatter that creates the final shape once.

### Garbage Collection

Modern JS engines are generational. Short-lived allocations are usually cheap; long-lived object graphs and caches are not. Object pooling often makes performance worse because it promotes objects into older generations and keeps memory live.

Use this rule:

- Allocate small request-local objects freely when profiles show they die young.
- Cap every long-lived cache by count and bytes.
- Avoid retaining large row arrays, section arrays, and string copies across requests.
- Treat `Map`/`Set` indexes as memory products, not free helpers.
- Use heap snapshots for leaks, but also watch RSS/native heap because Bun has JS heap and non-JS heap memory.

## Recommendations

### P0: Add Performance Guardrails Before More Tuning

Add a `docs/perf/` workflow or `reports/perf/` output that records:

- Bun CPU profile: `bun --cpu-prof --cpu-prof-dir reports/profiles ...`
- Bun heap profile: `bun --heap-prof --heap-prof-dir reports/profiles ...`
- Real-corpus search benchmark with fixed cases and concurrency: direct, API cache off, API cache on.
- Heavy-mix benchmark that includes fuzzy/body and asserts that SLO routes stay below target while heavy work is active.

Add web metrics equivalent to MCP metrics:

- `apple_docs_web_search_requests_total{mode,cache,deep,fuzzy}`
- `apple_docs_web_search_latency_ms_bucket{case_or_tier}`
- `apple_docs_web_reader_pool_pending{op}`
- `apple_docs_web_reader_pool_timeouts_total{op}`
- `apple_docs_web_search_cache_bytes`
- `apple_docs_web_event_loop_lag_ms`
- `apple_docs_process_rss_bytes`
- `apple_docs_process_heap_bytes`

For Bun, event-loop lag can be implemented portably with a low-overhead interval drift sampler using `performance.now()` or `Bun.nanoseconds()`. For Node compatibility paths, `perf_hooks.monitorEventLoopDelay()` and `eventLoopUtilization()` are the direct APIs.

### P0: Isolate Heavy Reader Work

Current result: with fuzzy/body enabled, concurrency 8 pushed SLO p99 to 1967.54 ms because expensive operations share the reader workers.

Recommended design:

- Maintain a `strictReaderPool` for exact/title/FTS/trigram requests.
- Maintain a `deepReaderPool` for `searchBody` and `fuzzyMatchTitles`.
- Give `deepReaderPool` lower size, shorter queue, and aggressive timeout.
- Return partial search results if body/fuzzy times out.
- Add per-op timeout overrides:
  - exact/title/FTS/trigram: 50-100 ms for web
  - fuzzy: 250-500 ms
  - body: 500-1500 ms depending on route
- Add a per-route concurrency gate for deep search so one client cannot saturate the pool.

This is the highest-confidence user-facing performance improvement.

### P0: Fix `pool()` Queue Mechanics

`src/lib/pool.js` currently does:

- `const queue = [...items]`
- `queue.shift()` for each task

For large builds and syncs, this copies the entire input and repeatedly shifts the front of an array. Replace it with an index cursor:

```js
let next = 0
while (active.size < limit && next < items.length) {
  const item = items[next++]
  ...
}
```

This is mechanically simple and removes avoidable scheduler overhead on large document sets.

### P1: Reduce Worker Message Payloads

Worker threads help only when the saved main-thread work exceeds serialization and scheduling overhead. Node's docs explicitly call out worker creation overhead and recommend pools for repeated CPU work; this code already uses a pool. The next step is reducing structured-clone costs.

Recommendations:

- For search, return only IDs/scores from worker SQL where possible, then batch-fetch final display rows once.
- Or move ranking and formatting fully inside the worker, returning only final top-N.
- Avoid sending rich row objects and parsed platform structures across workers.
- For large binary/index data, use transferable `ArrayBuffer`s or `SharedArrayBuffer` rather than cloned object graphs.
- For browser search artifacts, consider compact binary postings: sorted `Uint32Array` lists, delta varints, or a small Roaring bitmap implementation.

Do not use `SharedArrayBuffer`/`Atomics` unless there is a measured high-frequency coordination problem. They increase complexity and, in browsers, require cross-origin isolation for shared memory availability.

### P1: Make Fuzzy Search Algorithmic, Not Just Parallel

Current fuzzy search builds an all-title trigram cache per process and then performs Levenshtein checks over candidates. Benchmarks show typo fuzzy can run above 1 second on the full corpus.

Recommendations:

- Avoid one full trigram cache per reader worker. Use one dedicated fuzzy worker, a persisted compact index, or a shared typed-array artifact.
- Use the SQLite trigram table to fetch narrower candidates before Levenshtein.
- Apply length windows and rare-trigram ordering before candidate materialization.
- Cap fuzzy work by candidate count and wall deadline.
- Treat fuzzy as progressive enhancement: return strict results first, then fuzzy supplement only when cheap.

### P1: Rework Body Search UX and Execution

Body search is multi-second in the benchmark. That is acceptable for explicit "deep search" only if isolated.

Recommendations:

- Keep deep/body disabled by default on header search and normal API calls.
- Put body search behind explicit route/query intent.
- Return title results immediately and append body results asynchronously in the UI.
- Push filters into SQL before body FTS wherever possible.
- Add a body-specific result cap and deadline.
- Consider a smaller body summary index for interactive search and reserve full body FTS for exhaustive mode.

### P1: Make Browser Worker Indexes More Compact

`src/web/worker/search-worker.js` builds `Map<string, Set<number>>` for exact and prefix lookup. This is simple and fast enough for current scale, but memory grows quickly because every `Set` has object overhead.

Recommendations:

- Continue using a Web Worker for index build and query.
- Replace posting `Set`s with sorted arrays or typed arrays after build.
- Store prefix lists only for useful prefixes; skip very common prefixes or cap list lengths.
- Use transferables for prebuilt binary index artifacts.
- Add a worker memory budget test using the production-sized title index.
- Use `scheduler.yield()` only as progressive enhancement for main-thread rendering work; MDN marks it limited availability, though it is available in workers where supported.

### P1: Tighten Hot Object Shapes

Create predictable result and view-model objects:

- Avoid object spreads in tight loops when a purpose-built constructor function is cheap and clearer.
- Assign properties in one order.
- Prefer `null` over sometimes-missing properties for stable shapes when objects are hot and numerous.
- Keep row normalization separate from raw DB row objects.
- Avoid mutating DB row objects into final API objects.

Potential targets:

- `formatResult()` and search result assembly in `src/commands/search.js`
- Browser worker scored result objects
- Template view-model builders
- Search artifact columnar structures

### P1: Avoid Main-Thread Sync Work on Request Paths

Already improved: non-hashable sync gzip was removed.

Remaining risk: hashable dynamic responses still call `response.text()`, hash the whole body, and may call `gzipSync()` on cache miss. That may be acceptable for cached small JSON, but it should be measured under browser `Accept-Encoding: gzip`.

Recommendations:

- Prefer edge/Caddy compression for dynamic API JSON.
- If origin compression is needed, cache compressed payloads at the same level as search results.
- Add latency metrics around `finalizeResponse()`.
- Keep synchronous filesystem, child process, zlib, regex, and large JSON operations off request paths.

### P2: Propagate Cancellation End-to-End

The lower-level utilities use `AbortSignal.timeout()` and `AbortSignal.any()` patterns, but some pipeline functions do not pass a signal all the way to fetch/render work.

Recommendations:

- Make `downloadMissing()`, `convertAll()`, web on-demand fetches, and render helpers accept and propagate `signal`.
- Ensure queued work exits before starting new tasks when aborted.
- Use typed timeout errors so metrics can distinguish timeout, backpressure, cancellation, and application errors.

### P2: Tune Bun Worker Configuration

Bun workers support `smol: true`, which reduces worker memory by using a smaller JavaScriptCore heap at a performance cost. This is relevant for reader workers that hold SQLite handles and perhaps large fuzzy caches.

Recommendations:

- Benchmark reader workers with and without `smol: true`.
- Do not enable `smol` blindly for strict search if p99 worsens.
- Consider `smol` for low-priority deep/fuzzy workers, where memory protection may matter more than peak speed.
- Use `ref: false` for auxiliary workers that should not keep the process alive.
- Use `preload` only for instrumentation that must exist before worker startup.

### P2: Use Build-Time Constants for Dead Code

Bun's `--define` can replace statically analyzable globals and enable dead-code elimination/minification.

Recommendations:

- For browser bundles and production server starts, replace stable flags such as `process.env.NODE_ENV`.
- Avoid reading environment variables repeatedly inside hot loops; parse once into config.
- Keep debug/profile branches behind static constants when building browser assets.

## Latest APIs Worth Leveraging

| API | Recommendation |
| --- | --- |
| `AbortSignal.timeout()` / `AbortSignal.any()` | Continue using; propagate everywhere long work can start or queue. |
| `Worker` / `worker_threads` | Keep using pools. Split pools by workload class. Avoid one worker per task. |
| Transferable `ArrayBuffer` / `structuredClone(..., { transfer })` | Use for large index or binary payloads crossing workers. |
| `SharedArrayBuffer` + `Atomics.waitAsync()` | Reserve for measured shared-memory queues; do not use for normal search messages. |
| `PerformanceObserver`, `performance.mark/measure` | Add around search tiers, render phases, fetch phases, response finalization. |
| Node `perf_hooks.monitorEventLoopDelay()` / `eventLoopUtilization()` | Use on Node-compatible paths and as design reference for Bun's interval-drift sampler. |
| Bun `--cpu-prof`, `--heap-prof`, `Bun.nanoseconds()` | Make these first-class perf workflow tools. |
| Bun worker `smol` | Benchmark for low-priority worker pools. |
| `scheduler.yield()` / `scheduler.postTask()` | Progressive enhancement for browser UI long tasks only; not portable enough as a required primitive. |
| WebAssembly SIMD | Consider only for isolated CPU kernels such as PDF/SVG/font parsing after profiles prove JS is the bottleneck. |

## What Not To Do

- Do not rewrite broad code to "manual C-style JavaScript" without profiles.
- Do not use object pools for small request objects unless heap profiles prove allocation/GC is the bottleneck.
- Do not add `SharedArrayBuffer`/Atomics for ordinary worker request/response messaging.
- Do not optimize for V8 alone while production runs on Bun/JSC.
- Do not let fuzzy/body searches share the same SLO budget as normal title search.
- Do not add cache layers without byte caps and invalidation tied to corpus stamps.

## Proposed Implementation Plan

Phase 1: measurement and one mechanical fix

1. Add web metrics provider mirroring MCP metrics.
2. Add event-loop lag sampler and process memory gauges.
3. Replace `pool()` queue shifting with index cursor.
4. Add a benchmark case that mixes SLO search with fuzzy/body load.

Phase 2: tail-latency isolation

1. Split reader pools by workload class.
2. Add per-operation deadlines and per-operation metrics.
3. Return partial results on deep/fuzzy timeout.
4. Add deep-search route/UI behavior that does not block normal results.

Phase 3: memory and worker payload reduction

1. Slim worker search messages to IDs/scores or move final ranking into the worker.
2. Replace per-worker fuzzy cache with a dedicated or persisted compact index.
3. Convert browser worker postings from `Set` to compact sorted arrays/typed arrays.
4. Add heap snapshot comparisons for server startup, reader pool warmup, browser search worker init, and web build.

Phase 4: JIT shape hygiene

1. Normalize DB rows into final result objects in one pass with stable property order.
2. Avoid hot-path object spread where it creates large numbers of temporary objects.
3. Keep packed arrays and avoid holes/out-of-bounds reads in worker indexes and result loops.
4. Add microbenchmarks only after a profile points to a specific hot function.

## Source Notes

Primary and official sources used:

- Bun Runtime: https://bun.com/docs/runtime
- Bun Benchmarking, CPU profiles, heap profiles, and memory notes: https://bun.com/docs/project/benchmarking
- Bun Workers, `smol`, `ref`, `preload`, environment data: https://bun.com/docs/runtime/workers
- Bun `--define`: https://bun.sh/docs/guides/runtime/define-constant
- Node Event Loop guide: https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick
- Node "Don't Block the Event Loop": https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop
- Node Worker Threads: https://nodejs.org/api/worker_threads.html
- Node Performance APIs: https://nodejs.org/api/perf_hooks.html
- MDN Web Workers: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers
- MDN Transferable Objects: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects
- MDN Atomics: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics
- MDN Scheduler `yield()`: https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield
- WebKit FTL JIT: https://webkit.org/blog/3362/introducing-the-webkit-ftl-jit/
- WebKit Speculation in JavaScriptCore: https://webkit.org/blog/10308/speculation-in-javascriptcore/
- WebKit JavaScriptCore GC: https://webkit.org/blog/12967/understanding-gc-in-jsc-from-scratch/
- WebKit Riptide concurrent GC: https://webkit.org/blog/7122/introducing-riptide-webkits-retreating-wavefront-concurrent-garbage-collector/
- V8 Maglev: https://v8.dev/blog/maglev
- V8 Fast Properties: https://v8.dev/blog/fast-properties
- V8 Hidden Classes/Maps: https://v8.dev/docs/hidden-classes
- V8 Elements Kinds: https://v8.dev/blog/elements-kinds
- V8 Orinoco GC: https://v8.dev/blog/trash-talk
