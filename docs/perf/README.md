# Performance workflow

Canonical commands for profiling and benchmarking apple-docs. See
`docs/research/2026-05-10-javascript-performance-sota.md` for the
underlying SOTA report and `docs/plans/2026-05-10-javascript-performance-sota.md`
for the phased implementation plan.

## Profiling

### CPU profile (Bun)

```bash
bun run perf:cpu cli.js web serve --port 3030
# …exercise the workload (curl, browser, bench)…
# Ctrl-C → reports/profiles/CPU.<timestamp>.cpuprofile
```

Open the resulting `.cpuprofile` in Chrome DevTools (Performance tab → Load
profile) or `bunx speedscope reports/profiles/CPU.*.cpuprofile`.

### Heap profile (Bun)

```bash
bun run perf:heap cli.js web serve --port 3030
# …reproduce the suspected allocation hotspot…
# Ctrl-C → reports/profiles/Heap.<timestamp>.heapprofile
```

Same DevTools / speedscope flow.

### Cold-vs-warm heap diff

For "what does the trigram cache + render cache + reader-pool warmup
actually retain?" use the snapshot-diff harness:

```bash
scripts/heap-snapshot-diff.sh --warmup 20 --port 3030
```

Boots two instances back-to-back (cold + warm), runs a 20-second curl
burst against the warm one, and writes both `.heapprofile` files plus
a one-page summary into `reports/profiles/`. Open both in Chrome
DevTools' **Memory tab → Comparison view** to attribute the warm RSS
delta to specific constructors.

Common warm-vs-cold offenders worth comparing:
- `Map` from `lib/fuzzy.js` (`_trigramCache`) — multi-hundred-MB on
  full corpus, deferred to phase 3.2.
- `Map` from `web/render-cache.js` triple-index.
- Prepared-statement strings + FTS row arrays.

### Snapshot a single hot path

```bash
bun --cpu-prof --cpu-prof-dir reports/profiles \
  test/benchmarks/search-mixed-bench.js --concurrency 8 --iterations 100
```

## Benchmarks

| Script | Purpose |
|---|---|
| `bun run bench` | Existing micro-benchmarks (search, highlight, pipeline, seed) |
| `bun run bench:search-real` | Real-corpus search latency (default + cache off/on, mixed concurrency) |
| `bun run bench:mixed` | SLO + heavy fuzzy/body interleaved — phase-2 regression gate |

The mixed benchmark expects the dev DB at `~/.apple-docs/apple-docs.db`
(or pass `--db <path>`). It reports SLO p99 separately from heavy p99 so
the phase-2 split-pool change is visible.

## Metrics scrape

```bash
bun cli.js web serve --port 3030 --metrics-port 9101
curl -sS http://127.0.0.1:9101/metrics
```

Phase 1.1 mirrors the MCP metrics surface on the web listener:

- `apple_docs_web_search_requests_total{mode,cache,deep,fuzzy}`
- `apple_docs_web_search_latency_ms_bucket{tier}` (cumulative histogram)
- `apple_docs_web_reader_pool_pending{op}`
- `apple_docs_web_reader_pool_timeouts_total{op}`
- `apple_docs_web_search_cache_bytes`
- `apple_docs_web_event_loop_lag_ms{quantile}`
- `apple_docs_process_rss_bytes`
- `apple_docs_process_heap_bytes{kind}`

## Output locations

- CPU/heap profiles: `reports/profiles/` (gitignored)
- Benchmark history: `test/benchmarks/*.jsonl` (gitignored)
- Latest run summary: stdout

## Cleanup

```bash
rm -rf reports/profiles
```
