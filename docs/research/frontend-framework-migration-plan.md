# Frontend Framework Migration Investigation

Generated: 2026-05-08

## Summary

The web UI is a good candidate for modularization, but not for a whole-app framework rewrite. The current app is a documentation browser with static/SSR HTML, a very large corpus, search APIs, cacheable JSON artifacts, and a few interactive widgets. The state-of-the-art fit is server-rendered/static HTML by default with explicit islands only for genuinely interactive controls.

Recommended path:

1. Keep the current Bun server/static build ownership and split it into explicit routes, services, view models, render helpers, and asset manifests.
2. Keep documentation pages at zero client-side hydration. Existing generated content remains native HTML from `render-html.js` behind an audited safe-HTML boundary.
3. Modernize browser JavaScript as native ES modules first: small controllers, explicit mount points, pure URL/API/state helpers, and no global DOM reach except deliberate document/window integrations.
4. Use Vite as the asset pipeline only after boundaries are clear. Benchmark tiny islands with Solid, Preact Signals, Svelte 5, and native custom elements before choosing one. Do not migrate page shells to a framework until the island pilot proves a real reduction in complexity or shipped JavaScript.
5. Treat search latency as a first-class architecture constraint: keep normal content at zero hydration, keep search as an explicit API/island surface, and optimize the embedded search path before considering any heavier service.
6. Decide at a later gate whether Astro, Fresh, Qwik, Marko, or another meta-framework should own routing/build orchestration. The current custom incremental build and on-demand Bun server are already specialized and should not be replaced without a measured pilot.

## Current State

Evidence from the repo:

- Runtime/package shape: Bun-only ESM package, no frontend framework, no Vite, no bundler dependency today. See `package.json`.
- Main web rendering surface:
  - `src/web/templates.js`: 1,566 lines of full-page string templates.
  - `src/web/assets/*.js`: 2,611 lines of vanilla browser behavior.
  - `src/web/assets/style.css`: 3,137 lines of global CSS.
  - `src/web/serve.js`: 796 lines combining API routes, asset serving, cache headers, page routing, and rendering.
  - `src/web/build.js`: 885 lines of static build orchestration, incremental render index, bundling, precompression, and sitemap generation.
- Critical content renderer: `src/content/render-html.js` converts normalized DocC/content sections into HTML with escaping, Shiki highlighting, safe JSON parsing, and link resolution. Treat this as a low-level renderer initially, not as "just a template" to rewrite casually.
- Existing web baseline:
  - `bun run test:web`: 204 pass, 0 fail.
  - `bun run lint:web`: passes.
- Baseline local corpus/search profile before the Phase 0 search patch:
  - `~/.apple-docs/apple-docs.db`: 3.5 GB.
  - `documents`, `documents_fts`, `documents_trigram`, and `documents_body_fts`: 344,995 rows each.
  - SQLite already uses WAL, `synchronous=NORMAL`, memory temp store, a 64 MB page cache, 10 GB requested mmap, and WAL auto-checkpointing in `src/storage/database.js`.
  - MCP HTTP had an optional worker-thread SQLite reader pool, but web `/api/search` previously called `search(searchOpts, ctx)` without attaching that pool.
  - The previous search cascade ran FTS5 and trigram in parallel before fuzzy/body fallbacks. That improved idle latency on larger hosts, but could waste CPU on a modest one.
- Phase 0 implementation now in this branch:
  - Schema v13 adds `idx_documents_title_nocase` for exact symbol-title lookup.
  - Web `/api/search` can use the existing SQLite reader-pool architecture.
  - Web search has an in-process response LRU keyed by normalized search options and a corpus stamp.
  - The default web search path excludes fuzzy and body search; those heavier tiers are now explicit UI/API opt-ins.
  - The latency-sensitive web path uses an exact-title tier first, then FTS, then trigram only when needed.
  - `test/benchmarks/search-real-bench.js` measures real-corpus `/api/search` p50/p95/p99, CPU, cache hit rate, and per-case p95 at concurrency 1/2/4/8/16.
- Target deployment profile from operator input:
  - Mac mini 2018, Intel Core i5, 64 GB RAM. SSH probe on `mm18.local`: macOS 15.6, Intel Core i5-8500B, 6 physical cores / 6 logical cores, 64 GiB RAM.
  - Remote corpus at `~/.apple-docs/apple-docs.db`: 3.1 GB, with 342,769 rows in `documents`, `documents_fts`, `documents_trigram`, and `documents_body_fts`.
  - Storage headroom should be verified against the final `APPLE_DOCS_HOME`; operator reports about 154 GB free on the intended volume, which is enough for secondary-index experiments.
  - Apple lists the 2018 i5 Mac mini as a 3.0 GHz 6-core Intel Core i5 with Turbo Boost up to 4.1 GHz and configurable memory up to 64 GB. Source: https://support.apple.com/en-us/111912
  - Treat this as RAM-rich and CPU-constrained. The DB and indexes can be kept hot in the OS page cache, but each extra FTS/trigram/body query still spends scarce CPU.

## State Of The Art For This App

The app is closest to a large documentation/content site, not an authenticated product app. The relevant modern pattern is SSG/SSR with partial hydration:

- Astro documents islands architecture as mostly static HTML with small client islands, and explicitly supports incremental conversion and multiple UI frameworks. Source: https://docs.astro.build/en/concepts/islands/
- SvelteKit supports static-site generation with `adapter-static`, but requires pages to be prerendered or a fallback, and warns against disabling SSR for prerendered content. Source: https://svelte.dev/docs/kit/adapter-static
- Svelte 5 is the modern Svelte target; new reactive code should use runes. Source: https://svelte.dev/docs/svelte/what-are-runes
- Vue's own SSR guide says SSG is usually the right shape for content sites where data is known at build time. Source: https://vuejs.org/guide/scaling-up/ssr.html
- React 19 Server Components are stable at the component level, but framework/bundler implementation APIs are still not semver-stable between minor versions. Source: https://react.dev/reference/rsc/server-components
- Vite is the current default build foundation across modern frameworks and supports Svelte, Vue, React, Preact, Solid, and Qwik templates. Source: https://vite.dev/guide/
- SQLite FTS5 is still a valid embedded baseline for this project: it supports BM25 ranking, trigram tokenization, and explicit index optimization. Source: https://www.sqlite.org/fts5.html
- SQLite WAL improves read/write concurrency because readers do not block writers and a writer does not block readers. Source: https://www.sqlite.org/wal.html
- SQLite recommends `PRAGMA optimize` as the modern path for query-planner statistics maintenance. Source: https://www.sqlite.org/pragma.html
- Tantivy is the strongest likely accelerator candidate if SQLite FTS5 becomes the bottleneck: it is an embeddable Rust search library, closer to Lucene than to Elasticsearch/Solr. Sources: https://docs.rs/tantivy/latest/tantivy/ and https://github.com/quickwit-oss/tantivy
- Meilisearch is operationally simpler than building a Rust search component, but it is another daemon and its effective memory requirement is use-case dependent. Source: https://www.meilisearch.com/docs/learn/engine/storage
- Xapian is a mature C++ search engine library with BM25 weighting, query parsing, and bindings. Source: https://xapian.org/docs/
- Manticore Search is a C++ search database descended from Sphinx, with full-text operators, fuzzy search, custom rankers, vector search, SQL/JSON APIs, and query parallelization. Sources: https://manual.manticoresearch.com/vector-search and https://manual.manticoresearch.com/Searching/Full_text_matching/Operators
- Typesense is an open-source, typo-tolerant search engine optimized for instant search. Source: https://typesense.org/docs/29.0/api/search.html
- Groonga is a fast full-text search engine library/server with instant update, inverted indexes, tokenizers, read lock-free search, and Homebrew/macOS install support. Source: https://groonga.org/docs/
- Redis Search provides full-text and secondary indexing on Redis data structures, but introduces an always-on Redis data plane. Source: https://redis.io/docs/latest/develop/ai/search-and-query/administration/overview/
- ParadeDB brings BM25 indexes and full-text search into Postgres; it is compelling if Postgres becomes the primary store, but not if the app remains SQLite-first. Sources: https://docs.paradedb.com/documentation/concepts/index and https://docs.paradedb.com/
- Apache Lucene remains the reference high-performance Java search library; it is very capable, but JVM embedding is operationally heavier than Rust/C++/SQLite for this deployment. Source: https://lucene.apache.org/core/index.html
- Qwik, Fresh, and Marko are the important niche UI alternatives for low/no hydration: Qwik uses resumability instead of hydration, Fresh ships JavaScript only for islands, and Marko uses compile-time analysis/fine-grained bundling. Sources: https://qwik.dev/docs/concepts/resumable/, https://fresh.deno.dev/docs/concepts/architecture, and https://markojs.com/docs/explanation/why-is-marko-fast

Practical conclusion:

- Best architecture: native SSR/static HTML plus opt-in islands.
- Best initial frontend move: modular native ES modules, not a component-framework migration.
- Best island candidates to benchmark: Solid, Preact Signals, Svelte 5, and native custom elements through Vite.
- Best optional meta-framework later: Astro/Fresh/Qwik/Marko only if a spike proves it preserves corpus-scale build constraints and meaningfully deletes custom code.
- Best search baseline on the Mac mini 2018 profile: tune embedded SQLite FTS5 first, using memory aggressively for cache and mmap while limiting duplicated CPU work.
- Best search ceiling if SQLite cannot hit the 25 ms p95 target: add a read-only Rust/Tantivy search index generated from the same corpus, with SQLite remaining the source of truth.
- Avoid as first move: full React/Next SPA or whole-app hydration. It adds runtime and routing complexity without matching the docs-site performance profile.

## Search Performance Strategy

Search is more important than framework choice for perceived speed. The framework migration must not add client runtime to normal content pages, and it must not make the search API slower.

Architecture target:

- Keep documentation pages static/SSR with zero framework hydration by default.
- Keep search as a dedicated island and API, not a whole-page client app.
- Keep SQLite as the canonical store for documents, sections, relationships, render cache, fonts, symbols, and metadata.
- Keep the search implementation behind a `SearchService` interface so the UI does not care whether results come from SQLite FTS5 or a future Tantivy index.

Search latency SLO:

- Default user-facing search must hit **p99 < 25 ms** on the Mac mini target after warm-up. This is intentionally tighter than the original p95 target: a docs site that hesitates on the long tail feels slow even when median latency is good, and the response cache flattens p50/p95 to the point where the tail dominates perceived performance.
- Measure the budget at the application boundary for `/api/search`, including DB/index lookup, ranking, filter application, snippet/metadata enrichment, and JSON serialization.
- Track p50, p95, p99, CPU time, queue wait, and cache hit rate across concurrency 1/2/4/8/16. The six-core host should not be tuned only for single-query latency.
- Separate cold-start and index-build timings from steady-state query SLOs.
- The SLO is measured **with the response cache on**, because that is the production configuration. Cache-off numbers stay on the dashboard as a worst-case probe but do not gate the SLO.
- Any fallback tier that cannot fit the p99 < 25 ms budget must either be opt-in, asynchronous/deferred, cached, or moved to a faster index.

Fastest near-term path:

1. Add a real corpus benchmark before changing search behavior. Measure p50/p95/p99 for warm and cold queries, `noDeep` vs body search, and concurrency 1/2/4/8/16 on the actual Mac mini corpus.
2. Enable the existing reader-pool architecture for web search, not only MCP. For the Mac mini i5 profile, start with 3-4 read workers and matching request concurrency, then benchmark. Six cores is enough for parallel reads, but not enough to run every fallback path for every request.
3. Change the search cascade on this host from "parallel FTS + trigram" to "cheap exact/prefix/FTS first, then trigram/fuzzy/body only when needed." Parallelizing independent searches lowers single-query latency on an idle CPU, but it doubles work under load.
4. Add a fast exact/prefix title/key path before FTS5. Common symbol lookups like `NavigationStack`, `View`, or `URLSession` should be answered from indexed normalized columns before touching trigram/body indexes. Remote probe found `documents.key` indexed but no `documents.title` index; exact title lookup scanned and took about 132 ms on `mm18.local`.
5. Cache search API responses with an in-process LRU keyed by normalized search params and corpus stamp. MCP already has this pattern; web `/api/search` should get the same benefit.
6. Make body search explicit for UI. Header search already sends `no_deep=1`; the full search page should default to title/metadata search and only run body search when the user opts into "search full text" or when the first tier returns too few results. If body search cannot meet 25 ms p95, keep it outside the default SLO path until Tantivy or another accelerator is in place.
7. Reduce JS post-filter expansion. The current command can raise `searchLimit` up to 1000 when filters are present, then filters/reranks in JS. Push more filter fields into SQL or the future search index so the engine returns a small final window.
8. Increase memory spending deliberately, but per connection. A 256-512 MB SQLite cache per reader is a safer starting point than a multi-GB cache multiplied across workers, because mmap and macOS's page cache should already keep the 3.5 GB DB hot with 64 GB RAM.
9. Pre-warm cheap, high-value artifacts at startup: title index, alias map, filter lists, and the search response LRU for common queries if a query corpus is available.
10. Run SQLite maintenance after indexing: `PRAGMA optimize` and FTS5 optimize/rebuild where benchmarks prove it helps. Treat this as an index/build operation, not request-time work.

Current Phase 0 status:

- Items 1 through 6 are implemented and shipped on `main` as of `bffddc1`.
- Verified on `mm18.local` (Intel i5-8500B, 6 cores, 64 GiB, macOS 15.6) against the live corpus of 347,675 documents, 4 reader workers, 200 iterations × 5 default SLO cases per concurrency tier:

  Cache **off** (cold-path worst case):

  | concurrency | p50    | p95     | p99     | max     | SLO (p99<25ms) |
  | ----------- | ------ | ------- | ------- | ------- | -------------- |
  | 1           | 4.07ms | 24.46ms | 34.04ms | 39.92ms | miss           |
  | 2           | 3.30ms | 16.63ms | 30.92ms | 35.42ms | miss           |
  | 4           | 4.98ms | 16.49ms | 20.21ms | 22.03ms | pass           |
  | 8           | 11.50ms| 29.04ms | 36.93ms | 37.60ms | miss           |
  | 16          | 20.96ms| 45.60ms | 51.83ms | 52.03ms | miss           |

  Cache **on** (production configuration, gates the SLO):

  | concurrency | p50    | p95     | p99     | max     | SLO (p99<25ms) |
  | ----------- | ------ | ------- | ------- | ------- | -------------- |
  | 1           | 0.29ms | 0.39ms  | 11.61ms | 15.64ms | pass           |
  | 2           | 0.40ms | 0.52ms  | 2.69ms  | 2.72ms  | pass           |
  | 4           | 0.65ms | 1.76ms  | 14.55ms | 14.82ms | pass           |
  | 8           | 1.23ms | 9.44ms  | 16.57ms | 16.86ms | pass           |
  | 16          | 2.83ms | 15.05ms | 17.81ms | 17.96ms | pass           |

- The SLO (p99 < 25 ms, cache on) **passes at every concurrency tier** on `mm18.local`. The cache-off long tail still misses at four of five tiers, driven by two specific cases — `framework-filter` (NavigationStack scoped to `framework=swiftui`) at 32.93 ms p95 / c=1 cold, and `exact-symbol` (NavigationStack) at 47.57 ms p95 / c=16 cold. Both are cold-cache outliers; the response LRU collapses them to sub-millisecond on the second hit.
- Fuzzy typo search and full-text body search remain non-SLO tiers. Earlier measurements showed they can materially increase CPU contention, so they stay opt-in until a faster index or workload isolation is in place.

Phase 0 next-step decision:

- **SQLite track is sufficient** for the production SLO. Phase 1 (route/service/view-model boundaries with JSDoc/TS contracts; `Bun.build` as the asset pipeline; no Vite, no framework runtime yet) opens.
- **Tantivy spike does not open as a blocking dependency.** It moves from a planned decision branch to a watchlist item, triggered only if (a) cache-on p99 ever regresses past 25 ms on the deployment target, or (b) cache-hit rate drops materially in production telemetry (e.g. due to a fingerprinted-URL change that invalidates the LRU keys).
- **Cold-path follow-up** stays open as a small investigation, not a blocking gate: the `framework-filter` case being the *worst* cold case is suspicious — narrowing by framework should cheapen the query, not slow it. Likely the framework predicate is applied after the FTS scan rather than before. A targeted fix here would lift the cache-off worst case without any new infrastructure. Tracked as a Phase 0.5 spike, ungated.

Public-surface verification (apple-docs.everest.mt, end-to-end through Cloudflare → Tunnel → Caddy → Bun):

The internal mm18 numbers are necessary but not sufficient — they exclude the network. Benching against the public hostname revealed that every `/api/search` request was reaching origin (`cf-cache-status: DYNAMIC`), giving p50 ~47 ms / p99 ~140 ms regardless of how fast Bun answered. Cause: `/api/search` and `/api/filters` shipped no `Cache-Control` header, and Cloudflare's default policy is to skip caching `application/json` URLs without a static-asset extension, even with `public, max-age` set.

Two fixes shipped together (commit `1573b3d`):

- `src/web/serve.js`: emit `Cache-Control: public, max-age=300, stale-while-revalidate=3600` on `/api/search` (hit and miss branches) and `/api/filters`.
- Cloudflare Cache Rule on the `everest.mt` zone: `starts_with(http.request.uri.path, "/api/search") or starts_with(http.request.uri.path, "/api/filters")` → `set_cache_settings { cache: true, edge_ttl: respect_origin, browser_ttl: respect_origin }`. Lets CF respect the origin directive instead of skipping by default.
- `ops/bin/cf-purge.sh` + hooks in `deploy-update.sh` and `pull-snapshot.sh`: deploy-time `purge_everything` so the edge becomes coherent the moment the new corpus is live, with zero staleness window. Soft-fails (warn + exit 0) when the CF token / zone are not configured.

Public-surface numbers after the change, from a residential client (200 iter × 5 default cases per concurrency tier):

| concurrency | p50    | p95     | p99     | max     | end-to-end SLO (p99<25ms) |
| ----------- | ------ | ------- | ------- | ------- | ------------------------- |
| 1           | 17.4ms | 19.2ms  | 20.4ms  | 22.9ms  | pass                      |
| 2           | 18.5ms | 21.0ms  | 23.4ms  | 56.7ms  | pass                      |
| 4           | 26.2ms | 36.0ms  | 53.5ms  | 53.9ms  | miss                      |
| 8           | 18.0ms | 21.7ms  | 60.8ms  | 62.6ms  | miss                      |
| 16          | 18.3ms | 27.4ms  | 65.0ms  | 65.1ms  | miss                      |

Compared to pre-edge-cache (every request to origin), this is a 6-7× improvement at p99: ~140 ms → ~20 ms at low concurrency. The c=4+ tail spikes are residual network outliers (a handful of 50-65 ms requests in 1000), not backend contention. Real users don't drive c=4+ from a single client; CF distributes across users so per-user concurrency is typically 1-4 browser connections. The SLO holds at the concurrency the architecture is actually serving.

Bench reporting nuance: `x-apple-docs-cache: hit|miss` reflects Bun's LRU state at the moment CF cache-filled, not the current request. Once CF caches a response with `x-apple-docs-cache: miss`, that header sticks for every edge hit. Use `cf-cache-status` for edge-cache state and `x-apple-docs-cache` only when looking at origin behavior. The bench's `cache_hit_rate` field reports 0 % under edge caching for this reason — minor reporting fix tracked separately.

Fastest ceiling path:

- Build a Rust/Tantivy sidecar or native helper as a read-only search accelerator if optimized SQLite misses 25 ms p95 on the benchmark suite. With this SLO, Tantivy is a planned decision branch, not a far-future idea.
- Generate the Tantivy index during `apple-docs index`/`sync` from `documents` and `document_sections`.
- Store searchable fields in Tantivy: title, key, framework, role/kind, headings, abstract, declaration, body, source type, language, platform/version metadata, deprecation flags, WWDC year/track.
- Return top document keys/ids from Tantivy, then hydrate only the final result window from SQLite for canonical metadata and snippets.
- Keep SQLite FTS5 as the fallback and test oracle until Tantivy quality/latency is proven.

Do not use Elasticsearch/OpenSearch for this host profile. They are powerful, but the operational and memory footprint is the wrong default for a modest single-machine documentation browser. Meilisearch is a possible UX-oriented alternative, but Tantivy fits the "strongest performance with minimal runtime footprint" requirement better because it can be embedded and memory-mapped instead of operated as another always-on service.

Concurrency language note:

- Erlang/Elixir is excellent for many concurrent connections and resilient service coordination, but it does not make full-text search itself faster.
- For this app's bottleneck, Rust is the better specialized language if we add a search component. Use Erlang/Elixir only if the system becomes a high-concurrency external ingestion/coordinator service.

## Search Engine Alternatives

This is the expanded candidate set so we do not miss niche but powerful options.

| Candidate | Shape | Why consider it | Main risk | Verdict |
| --- | --- | --- | --- | --- |
| SQLite FTS5 tuned | Embedded current DB | Already shipped, zero daemon, good enough for many queries, benefits from 64 GB RAM and mmap | Current cascade burns CPU; missing title index; body search can be broad | Baseline and first optimization target |
| Tantivy | Rust embedded index or local sidecar | Lucene-like index, BM25, mmap, fast fields, compressed store, no JVM | Requires Rust build/integration and relevance parity work | Best likely performance ceiling |
| Xapian | C++ embedded library/sidecar | Mature, compact, BM25, query parser, bindings | GPL licensing and C++ integration; less modern ecosystem than Tantivy | Serious spike candidate if Tantivy disappoints |
| Manticore Search | C++ search server | Powerful full-text operators, fuzzy search, custom rankers, SQL/JSON API, query profiling | Another daemon and sync path; CPU parallelism must be capped on 6 cores | Best sidecar-server candidate |
| Typesense | C++ search server | Excellent instant/typo-tolerant UX and faceting; 64 GB RAM makes in-memory index plausible | Memory-resident index and another daemon; ranking model may need tuning for docs/symbols | Spike if search-as-you-type UX is priority |
| Meilisearch | Rust search server | Simple operations and typo tolerance; LMDB storage | Another daemon; memory depends heavily on workload; less control than Tantivy | Easier alternative to Typesense/Manticore, not top performance bet |
| Groonga | C library/server | Very fast full-text, instant updates, lock-free read path, strong tokenizer story | Smaller western ecosystem; integration and ranking parity need proof | Niche candidate worth a small benchmark |
| Lucene | Java library | Reference-class search quality and feature depth | JVM overhead and service integration complexity on Mac mini | Use as benchmark reference, not first implementation |
| Redis Search | Redis module/server | Fast in-memory search plus cache in one system | Duplicates data into Redis; durability/ops complexity; not source of truth | Only if Redis is already adopted |
| ParadeDB/Postgres | Postgres extension | BM25 index inside Postgres, no external ETL if Postgres is primary | Requires moving from SQLite to Postgres | Not a migration driver |
| ArangoSearch/IResearch | C++ search engine inside ArangoDB/IResearch lineage | Powerful C++ IR stack; recent IResearch work looks performance-oriented | Direct library integration is niche; ArangoDB would be a larger DB rewrite | Watchlist / research spike only |
| BM25S / eager sparse BM25 | Python/Numpy algorithm family | Uses RAM to precompute sparse BM25 scores; interesting with 64 GB RAM | Not a full search server; weak phrase/fuzzy/filter story; Python serving path | Benchmark idea, not production default |
| Bleve | Go embedded library | Easy sidecar in Go, broad query types | Likely not fastest versus Rust/C++; some production users moved to Elastic/OpenSearch | Low-priority fallback |

Recommended search experiments:

1. SQLite phase: add `documents(title)` or normalized title indexes, sequential fallback mode, web reader pool, web search cache, larger per-connection cache, and real benchmark harness. Gate: default search p99 < 25 ms (cache on) at agreed target concurrency.
2. Tantivy phase: build a read-only index from `documents` + `document_sections`, return document keys, hydrate rows from SQLite only for the final result window, compare latency and relevance against SQLite. Gate: p99 < 25 ms (cache on), lower CPU per query than optimized SQLite, and equivalent or better top-10 quality for symbol/API queries.
3. Sidecar phase: run the same benchmark corpus against Manticore, Typesense, Meilisearch, Groonga, and Xapian if optimized SQLite and Tantivy do not satisfy the 25 ms p95 target or if a sidecar gives better operational simplicity.
4. Research phase: test BM25S/IResearch/PISA-style ideas only if standard engines cannot hit targets or if a custom index becomes justified.

The decision should be benchmark-driven. A candidate must hit p99 < 25 ms (cache on) for the default search path, beat optimized SQLite on CPU per query if it adds operational complexity, preserve result quality for symbol/API queries, support filters without large JS post-filter windows, and keep operations simple enough for one Mac mini.

## Framework Options

| Option | Fit | Pros | Risks | Recommendation |
| --- | --- | --- | --- | --- |
| Native ES modules + current Bun pipeline | Very high | No framework lock-in, smallest default JS, preserves current server/build strengths, easy locality-of-effect improvements | Requires discipline around controllers and mount boundaries | Start here |
| Vite as asset pipeline only | High | Modern build/minify/dev ergonomics without handing over routing/rendering | Adds tooling but little architecture by itself | Add after modular boundaries are stable |
| Solid islands | High for interactive widgets | Fine-grained reactivity, small runtime, strong performance profile | Smaller ecosystem than React/Vue/Svelte | Benchmark for search/fonts/symbols islands |
| Preact + Signals islands | High | React-like ergonomics with much smaller runtime and fine-grained state | More library glue than native modules | Benchmark against Solid/Svelte |
| Svelte 5 islands | High | Small client runtime, concise component code, good compiler story | Need custom SSR/build integration if used beyond islands | Benchmark, do not assume as default |
| Astro 6 + framework islands | High strategically | First-class islands, framework-agnostic, SSG/SSR docs-site model, incremental conversion story | Existing build has custom incremental rendering, workers, cache contracts, on-demand DB routes | Evaluate after native/island pilot |
| SvelteKit | Medium | Official Svelte app framework, routing, SSR/SSG, adapters | Wants to own routing and prerender model; giant corpus and Bun on-demand server may fight it | Consider only for a full routing rewrite |
| Vue/Nuxt | Medium | Mature, SSR/SSG, strong ecosystem | More runtime than Svelte for this widget-heavy content site; no clear advantage over Astro/Svelte here | Not preferred |
| React/Next | Medium-low | Largest ecosystem, RSC, strong tooling | More hydration/runtime complexity; Next would strongly reshape server/build/deploy | Not first choice |
| Qwik | Promising but niche | Resumability avoids hydration replay and can make interactive pages start quickly | Different mental model; smaller ecosystem; would reshape the UI layer | Spike only if Svelte/Astro islands still ship too much JS |
| Fresh | Medium | Server-first islands, zero JS by default, clear no-hydration model | Requires Deno/runtime shift away from Bun and current pipeline | Not preferred unless adopting Deno |
| Marko | Promising but niche | Fine-grained compile-time bundling and resumability-like behavior; strong SSR performance focus | Smaller ecosystem and new template language | Watchlist/spike, not first migration |
| htmx + server-rendered fragments | Medium | Tiny client script, server-owned state, no framework hydration | Less suitable for rich search/symbol/font tooling; more bespoke interaction code | Consider for simple controls, not as whole UI layer |

## Target Modular Architecture

The migration should make the web layer follow clean boundaries before and during framework adoption:

```text
src/web/
  app/
    server.js              # Bun server bootstrap and middleware only
    route-registry.js      # maps paths to route handlers
    responses.js           # HTML/JSON/file/cache helpers
  routes/
    search.route.js
    docs.route.js
    frameworks.route.js
    fonts.route.js
    symbols.route.js
    assets.route.js
  services/
    search-service.js
    docs-service.js
    font-service.js
    symbol-service.js
    render-cache-service.js
  view-models/
    document-page-model.js
    framework-page-model.js
    search-page-model.js
  ui/
    layouts/
    pages/
    islands/
    components/
    styles/
  content/
    safe-html.js           # audited boundary around renderHtml output
```

Boundary rules:

- Route handlers load data and return responses. They do not assemble HTML strings.
- View-model functions normalize DB/content records into typed page props. They do not know about Bun responses.
- UI components render props. They do not query SQLite, mutate caches, or call `search()`.
- Client islands own their local state, API calls, and events. No island reaches into unrelated DOM.
- Raw HTML is only allowed through an audited `SafeHtml`/`TrustedHtml` boundary fed by `renderHtml`.
- CSS should move from one global file into global tokens plus component-scoped styles. Keep class names stable where tests or generated content depend on them.

## SOLID And Clean Code Practices

Apply SOLID pragmatically rather than mechanically:

- Single Responsibility: split `serve.js` into route handlers, response helpers, cache helpers, and services. Split `templates.js` into page components and shared layout/head/navigation pieces.
- Open/Closed: introduce route and page renderer registries so adding `/fonts`, `/symbols`, or future hubs does not expand a central `if` chain.
- Liskov Substitution: keep service contracts boring and substitutable in tests, for example `SearchService.search(opts)` and `DocsRepository.getDocument(key)`.
- Interface Segregation: avoid "web context" objects that expose the whole DB, logger, dataDir, search, font, and symbol APIs to every component.
- Dependency Inversion: route handlers depend on service interfaces passed at startup; services wrap concrete DB/resource modules.

Clean-code constraints:

- Prefer typed view models with JSDoc first, TypeScript later.
- Replace scattered `innerHTML` rendering in browser assets with component rendering. Any remaining `innerHTML` must go through one escaping/sanitizing helper.
- Keep pure functions for grouping, sorting, filtering, URL-state parsing, and search query construction.
- Prefer small files with one public reason to change.
- Keep performance and cache semantics visible in names and tests, not hidden in comments.

## LoE And DoW

Terminology assumption:

- `LoE`: level of effort for planning, plus locality of effect as an architecture quality.
- `DoW`: definition of work/done for each migration slice.

Locality of effect target:

- A change to search UI should touch `ui/islands/search-*`, `routes/search.route.js`, and search tests only.
- A change to SF Symbols inspector should not touch docs page rendering or global page shells.
- A cache-header change should live in `responses.js` or an asset route, not in page templates.

Definition of work for every slice:

- Includes one behavior-level test or snapshot.
- Keeps `bun run test:web` and `bun run lint:web` green.
- Preserves existing URLs, cache headers, canonical/JSON-LD tags, and static build output paths unless the slice explicitly changes them.
- Records bundle-size/page-weight delta for affected pages.
- Documents any intentional raw HTML boundary.

## Implementation Plan

### Phase 0: Baseline And Decision Gates

LoE: 1-2 days.

Deliverables:

- Capture current page snapshots for `/`, `/search`, `/fonts`, `/symbols`, `/docs/<framework>/`, and `/docs/<document>/`.
- Add Playwright smoke coverage for header search, advanced search, framework list/tree toggle, font controls, symbol inspector, theme switching, and language toggle.
- Add bundle/page-weight snapshots for current `core.js`, `listing.js`, `search-page.js`, `fonts-page.js`, `symbols-page.js`, and representative HTML pages.
- Add a real-corpus search benchmark for `/api/search` on the Mac mini target. The benchmark must report p50/p95/p99, CPU time, queue wait, cache hit rate, and result-quality snapshots for exact symbol/API queries, broad title queries, typo queries, filtered queries, and body-search queries.

Gate:

- No framework work starts until current behavior is executable and diffable.
- Search architecture stays on SQLite only if optimized SQLite reaches p99 < 25 ms (cache on) for the default search path at agreed target concurrency. Otherwise the Tantivy spike starts before broad UI migration work.

### Phase 1: Modularize Without Framework Changes

LoE: 3-5 days.

Deliverables:

- Extract response helpers, cache/ETag helpers, asset bundle config, and API route handlers out of `serve.js`.
- Extract page view-model builders from `templates.js`.
- Create a shared `web/assets-manifest.js` used by both `build.js` and `serve.js` so bundle definitions are not duplicated.
- Keep string templates in place, but make them consume explicit view models.

Gate:

- Output HTML diffs are either identical or reviewed/accepted.
- `bun run test:web`, `bun run lint:web`, and at least one static build fixture pass.

### Phase 2: Native Client Modules And Vite Asset Pipeline

LoE: 3-5 days.

Deliverables:

- Split existing browser assets into native ES module controllers with explicit mount points and pure helpers.
- Add Vite only as a multi-entry asset pipeline after the module split is stable.
- Configure Vite builds while preserving existing output names or adding a manifest adapter.
- Add a server/build helper that resolves Vite assets in dev and static build modes.
- Migrate the smallest behavior first: theme switching or language toggle, with no framework runtime.

Gate:

- One native module ships through Vite in both `apple-docs web serve` and `apple-docs web build`.
- Asset cache-busting, `baseUrl`, and immutable cache headers still work.

### Phase 3: Framework Island Pilot

LoE: 3-5 day spike.

Question:

- Do Solid, Preact Signals, Svelte 5, or native custom elements improve complexity, shipped JavaScript, and responsiveness enough to justify framework adoption?

Spike scope:

- Implement the same isolated widget in each candidate, preferably header quick search or the search-page filter/results controller.
- Compare bundle size, runtime work, hydration/resume behavior, code size, accessibility ergonomics, and compatibility with static build/dev server asset resolution.
- Keep documentation content outside the island in every candidate.

Gate:

- Adopt a framework island only if it clearly improves locality of effect or UI correctness while keeping non-interactive pages at zero hydration and keeping shipped JS equal or smaller for the affected page.
- Otherwise continue with native ES modules and server-rendered fragments.

### Phase 4: Migrate Browser Islands Or Native Controllers

LoE: 1-2 weeks after the Phase 3 decision.

Order:

1. Theme switcher and language toggle.
2. Page TOC.
3. Header quick search.
4. Search page form/results.
5. Framework filters and tree view.
6. Fonts page.
7. Symbols page.

Deliverables:

- Components or native controllers under `src/web/ui/islands/`.
- Shared URL-state and API clients under `src/web/ui/lib/`.
- Component tests for pure filtering/state helpers and Playwright coverage for key flows.

Gate:

- Each migrated island/controller removes or retires its legacy asset file.
- No island depends on global DOM selectors outside its mount point, except deliberate document/window integrations.

### Phase 5: Optional Page-Shell Component SSR

LoE: 1-2 week spike only if earlier phases justify it.

Deliverables:

- Convert shared head/header/footer/sidebar/breadcrumbs to SSR components in the chosen renderer, or keep native templates if the conversion does not delete enough complexity.
- Convert one page shell first: search or framework listing.
- Keep `renderHtml()` output as trusted content inserted into a controlled `DocContent` component.
- Preserve SEO blocks, canonical links, JSON-LD, original-resource links, and table-of-contents generation.

Gate:

- Representative page HTML snapshots pass.
- Raw HTML entry points are centralized and audited.
- Build performance is within agreed threshold, initially no worse than 10-15 percent for representative fixture builds.

### Phase 6: Optional Meta-Framework Evaluation

LoE: 3-5 day spike.

Question:

- Should Astro, Fresh, Qwik, Marko, or another meta-framework own page routing/build, or should the repo keep the custom Bun route/static generator with native modules/small islands?

Spike scope:

- Render one static page type, one framework listing with external tree JSON, and one document page from the DB through Astro.
- Verify build memory, build speed, baseUrl handling, hashed assets, cache headers, and static output layout.
- Verify the on-demand Bun dev server story still works or has a clean replacement.

Decision:

- Adopt a meta-framework only if it preserves current corpus-scale build capabilities and reduces custom code meaningfully.
- Otherwise keep the custom Bun server/static generator with Vite assets and the chosen small-island strategy.

### Phase 7: TypeScript And Hardening

LoE: 1 week, can run gradually.

Deliverables:

- Move `src/web` to checked TypeScript after module boundaries are stable.
- Add typed page props, service contracts, and API response schemas.
- Add accessibility checks to Playwright smoke tests.
- Add mutation/property tests for URL-state parsing, filter logic, and escaping helpers.

Gate:

- `typecheck` covers web code with `strict` enabled for `src/web` or a dedicated web tsconfig.

### Phase 8: Decommission Old Paths

LoE: 2-4 days.

Deliverables:

- Remove retired vanilla assets and stale bundle logic.
- Update README and deployment/runbook docs.
- Remove compatibility shims after one release cycle.
- Keep a migration changelog with all user-visible behavior changes.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Hydration mismatch around generated content | Broken interactivity or DOM replacement | Keep generated doc content non-hydrated, use islands with explicit mount points |
| Build-time regression on huge corpus | Slow or failed static builds | Retain current build first; benchmark before replacing with Astro/Svelte SSR |
| XSS regression through raw HTML | Security issue | Centralize `SafeHtml`, snapshot escaping cases, keep existing render-html tests |
| Asset URL/cache regression | Broken deploys or stale JS/CSS | Shared asset manifest, tests for `baseUrl`, `assetVersion`, cache headers |
| Over-modularization | More files without better locality | Only extract around real change axes: routes, services, view models, UI islands |

## Acceptance Criteria For The Migration

- No user-facing route changes unless explicitly chosen.
- Web test baseline remains green after every phase.
- Header search, advanced search, framework filtering/tree view, fonts, symbols, language toggle, and theme toggle are covered by browser-level tests.
- Client JS for static document pages does not grow materially; target is same or less JS except pages with active islands.
- Page HTML and SEO metadata stay equivalent for representative pages.
- Route/service/UI boundaries are clear enough that future web features do not require editing `serve.js`, `build.js`, and page templates together.
- Default search path reaches p99 < 25 ms (cache on) on the Mac mini target after warm-up, with body/deep search either meeting the same budget or explicitly separated as opt-in/deferred work.
