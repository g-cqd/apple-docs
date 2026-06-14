# RFC 0001 P6 — server execution records (archive)

Detailed records for the in-house SwiftNIO server (RFC 0001 §7 P6). Repo
documentation; never built or indexed. Parent:
[RFC 0001 §7 P6](../../0001-swift-native-transition.md).

---

## First slice — SwiftNIO host spike — EXECUTED 2026-06-13

### Scope

A standalone `ad-server` executable (the package's first SwiftPM dependency,
`apple/swift-nio`) booted ALONGSIDE the Bun servers, reading the same WAL
corpus, serving `GET /healthz` + `GET /search` (one `searchPages` query,
ADStorage IN-PROCESS, no FFI). The goal: a GO/NO-GO on the two foundational
unknowns gating all of P6/P7 — (1) can raw SwiftNIO host the HTTP layer, and
(2) does in-process native serving beat the Bun serving path (the cash-out of
P5's deferral). NOT the route table, the cascade, ranking, or the MCP
protocol.

### Decisions settled

- **First dependency: `apple/swift-nio` 2.101** (+ swift-atomics/system/
  collections, all apple/* — §2-compliant; D1: raw SwiftNIO, no Vapor).
  NIOCore + NIOPosix + NIOHTTP1 + NIOConcurrencyHelpers. Used ONLY by
  `ad-server`; the `libAppleDocsCore` product stays zero-dep. `Package.resolved`
  committed (its first).
- **Maximum strict concurrency (operator directive)**: `ad-server` builds with
  Swift 6 language mode + `-strict-concurrency=complete` in EVERY config. The
  server is the async/await NIO API (`NIOAsyncChannel`) + a structured
  `withThrowingDiscardingTaskGroup` accept loop + a **`Synchronization.Mutex`-
  guarded** connection pool (lightweight lock, NOT an actor — an actor funnels
  every request through one serial executor and caps throughput) — **no
  `@unchecked Sendable`, no `NIOLoopBound`, no data-race escape hatches**. The
  sole `@unchecked` is `ADStorage.StorageConnection` (it wraps a non-Sendable
  `sqlite3*`), contained by the pool handing one connection to one thread at a
  time. **TSan-clean** under 800 concurrent searches.
- **Platform floor raised to macOS 15.6** (operator decision 2026-06-13) — no
  longer macOS 13. Unlocks the `Synchronization` framework (`Mutex`/`Atomic`)
  + the modern structured-concurrency APIs (`DiscardingTaskGroup`) package-
  wide; still ≤ the macOS 26 production host (the dylib loads; x86_64 not yet
  deprecated). swift-atomics/swift-collections (already transitive via
  swift-nio) + swift-async-algorithms are the toolkit for the next slice's
  dedicated reader pool (operator direction: atomics/mutex/Deque over actors).
- **In-process surface**: `ADStorage.StorageConnection` (public) bypasses the
  FFI u64-handle registry; `searchPagesJSON` frames rows directly to JSON,
  hand-rolled to `[UInt8]` (NOT Foundation `JSONEncoder` — ~57× slower on
  Linux, P0 E6). Shared `bindSearchPages` + `searchPagesSQL` with the FFI path.
- **Blocking reads off the event loop** on a `NIOThreadPool`; connection
  checkout happens INSIDE the work closure (one per thread).

### Gate results (arm64, 10-core, release build, `ab -k -c 16 -n 8000`)

| Path | req/s | service time |
| --- | --- | --- |
| SwiftNIO `/healthz` | **67,188** | 0.015 ms |
| (iii) SwiftNIO `/search` in-process | 1,568 | 0.638 ms |
| (ii) Bun worker-pool (`runRead`, postMessage) | 3,961 | 0.252 ms |
| (i) Bun main-thread `bun:sqlite` | 2,960 | 0.338 ms |

- **(a) Host viable — GO.** SwiftNIO binds + serves on macOS-arm64 under a
  release build; **healthz 67k req/s ≥ Bun.serve** (62k).
- **(b) No event-loop stall — PASS.** `/healthz` stays at **0.13 ms p50**
  while a `/search` burst saturates the thread pool (the offload keeps the
  loops free).
- **(c) Query cost — parity-fine.** In-process `searchPagesJSON` is **0.32 ms/
  call** (single-request floor 0.5 ms incl. HTTP; curl confirms), byte-equal
  rows to JS `db.searchPages` (modulo float *notation*), consistent with P5's
  ~1.16× bun:sqlite.
- **(d) Concurrent serving — SwiftNIO ~2.5× SLOWER than the worker pool**
  (1,568 vs 3,961 req/s). **Gate (search ≤ worker-pool) NOT met.**

### Diagnosis (where the 2.5× lives)

NOT the host (healthz: 67k req/s) and NOT the query (0.32 ms, parity-fine).
The deficit is the **per-request async-offload machinery**: each `/search`
crosses ~4 executor boundaries (NIO event loop ↔ the connection Task ↔ the
`NIOThreadPool` ↔ back), and the async `runIfActive` continuation + the
`NIOAsyncChannel` EL↔Task bridging cost ~0.3 ms/request — *comparable to the
0.32 ms query itself*, so at single-query granularity the fixed overhead
dominates. Ruled out along the way (no effect): the actor vs lock pool, the
event-loop-group size (oversubscription), `TCP_NODELAY`, and the JSON
framing (column-name caching + zero-alloc int formatting). Also: the
bun-`fetch` load driver UNDER-drives a NIO server (it pooled fewer
connections to `ad-server` than to `Bun.serve`, inflating an early 3.8×
reading to a misleading number) — **`ab` is the authoritative client**; the
real deficit is 2.5×.

### Verdict — host GO; the single-query slice does NOT prove the inversion win

The SwiftNIO host is viable, fast, and provably safe — but **measuring ONE
`searchPages` is too fine-grained to demonstrate the P6 premise**: the fixed
async-offload overhead (~0.3 ms) rivals the tiny query (~0.3 ms), so it
dominates, and Bun's worker pool (which pays the same dispatch once but over
a C-native query) wins. The inversion win, if it exists, must come from
**amortizing one offload over MUCH more work** — the FULL search cascade
(4 tiers + ranking + fusion + snippets) run in-process in a SINGLE offload,
eliminating Bun's *per-tier* worker round-trips + the FFI — which this slice
deliberately did not port.

So: **do NOT proceed with a naive per-op SwiftNIO port** (it would regress
serving throughput ~2.5×). The next slice must EITHER:
1. Port the cascade in-process and re-measure **full-search vs full-search**
   (the granularity where the offload amortizes — the real test), and/or
2. Evaluate a lower-hop serving model (the classic `ChannelInboundHandler`
   + `EventLoopFuture` offload trades some of the max-safety for fewer
   executor hops; or a custom executor / request batching).

**Concurrency-primitive direction (operator)** for that slice: prefer
lightweight synchronization over the heavy async/actor machinery — the
`Synchronization` framework (`Mutex`/`Atomic`, now available package-wide at
the raised 15.6 floor; `swift-atomics` is the cross-platform `Atomic`
already transitively present), a mutex/atomic-guarded `swift-collections`
`Deque` for the work queue, and `swift-async-algorithms` for the cascade's
tier fan-out. The candidate model that directly attacks the measured hop
overhead: a **dedicated reader-thread pool** (N OS threads, each owning a
`StorageConnection`, pulling from one mutex/`Atomic`-guarded `Deque`,
signalled by a condition/`Atomic`), with the event loop handing work in and
getting bytes back via a single promise — the Swift analogue of Bun's worker
pool, but in-process and with ONE handoff instead of the cooperative-executor
+ `runIfActive` hop chain. (The actor → `Mutex` switch already done here
confirms the *pool* primitive is not the bottleneck; the win must come from
cutting the per-request hops.)

The `ad-server` foundation (host + connection pool + the in-process ADStorage
JSON surface) and the benchmark harness (`scripts/p6-*`) ship as the basis
for that measurement. Not wired into cli.js/ops/Caddy — inert to production.

### Artifacts

- `swift/Sources/ADServer/` (Main/Handler/ConnectionPool/QueryParse),
  `swift/Sources/ADStorage/StorageConnection.swift` + `PreparedStatement.runJSON`.
- `scripts/p6-host-bench.mjs` (orchestrator), `p6-bun-bench-server.mjs`
  (Bun main-thread + worker-pool comparison endpoints), `p6-seed.mjs`.
  Authoritative concurrency numbers via `ab` (the bun-fetch driver
  under-drives NIO — noted inline).
- `ad-server --bench N`: in-process `searchPagesJSON` timing (no NIO/offload).

### TLS / forward note

TLS stays upstream (Caddy/Cloudflare); the spike is plaintext localhost.
`apple/swift-tls` (new, pure-Swift TLS 1.3 for QUIC, SPI/unstable, part of
swift-network-evolution) is a **P7+/HTTP-3 watch item** — relevant only if
apple-docs ever terminates TLS in-process without swift-nio-ssl's BoringSSL
C-dep, or if SwiftNetwork matures into a swift-nio alternative.

---

## Second slice — lexical-cascade port — EXECUTED 2026-06-13

### Scope

The host spike's amortization hypothesis: a real `/api/search` does ~5 Bun
worker round-trips that collapse into ONE in-process offload in Swift. This
slice ported the **lexical cascade** (T1 title-exact + FTS, T2 trigram, the
merge, intent, rerank, projection — the 99%-of-queries hot path) into a real
Swift `/search`, to PROVE the inversion. Enrichment (snippet/relatedCount) +
fuzzy/body/relaxation/semantic + filters were deferred.

### Byte-parity — SUCCESS (the port is correct)

**The cascade ports byte-exactly.** `test/unit/native/search-cascade-parity.test.js`:
Swift `/search` JSON == JS `search()`→`projectSearchResult` JSON, byte for
byte, across the query matrix (every intent, tier boundary 0-3, miss, dotted
symbol). The key enabler: `projectSearchResult` strips ALL internal floats —
each hit is strings/ints/bools + a `confidence` *label*, never a raw score —
so the float-notation fight is AVOIDED; parity = ordering + projected fields.
The rerank scores are bit-identical (same IEEE `*=` ops in `ranking.js`
order), and a 4-key TOTAL-order sort (orig-index tie-break) reproduces JS's
stable sort. The FTS query builders (`buildFtsQuery`/`sanitizeTrigramQuery`,
insertion-ordered term dedup), `detectIntent` (regex, `nonisolated(unsafe)`
compiled patterns — the contained Regex-isn't-Sendable exception), the merge
(title-exact→FTS→trigram, dedup-by-path keep-first), and the hand-framed JSON
all match. New SERVER-ONLY `ADSearchCascade` target (keeps libAppleDocsCore
zero-dep); ADStorage gained `SearchRow` + `searchTitleExact`/`searchTrigram`.

### Performance — NO-GO (the amortization premise was wrong)

`ab -k -c16` over a 480-doc corpus, full-cascade vs full-cascade (Bun
`/search-core` = `search()` via the reader pool, enrichment skipped to match):

| | req/s | p50 |
| --- | --- | --- |
| Swift full cascade `/search` | **365-410** | 38-44 ms |
| Bun full cascade `/search-core` | **1066-1345** | 12-15 ms |

**Swift is ~3× SLOWER.** Cause: **Bun runs the 3 tiers in PARALLEL across
reader-pool workers** (`cascade.js` `Promise.all`), while Swift runs them
SEQUENTIALLY on one connection/thread in the single offload. On this corpus
`view` matches all 480 docs, so each FTS/trigram scan is heavy (~5 ms); 3
sequential ≈ 15 ms (Swift) vs ~max ≈ 5 ms (Bun parallel). More threads (10 vs
6) did NOT help (oversubscription); limit 20 vs 100 barely moved it (so it's
the per-tier QUERY cost, not the row decode). The host-spike "one offload
amortizes the hops" reasoning held for the HOPS, but missed that Bun's per-tier
**worker parallelism** is the real thing to beat — and a single sequential
in-process offload can't.

### Tier-parallel attempt + the scaling finding (the real bottleneck)

The cascade was then made TIER-PARALLEL — `ad-server` fans the 3 tiers via
`async let` to 3 thread-pool offloads (one connection each; pool sized = thread
count so a thread holds ≤1 connection and never starves), matching Bun's
per-tier parallelism in-process. Parity unchanged (10/10 — `assemble` is the
same). **It did NOT help: still ~368 vs ~1150 req/s.** A concurrency sweep
(`ab -c{1,4,8,16}`) localized why:

| concurrency | Swift req/s | Bun req/s |
| --- | --- | --- |
| 1 | **476** (2.1 ms) | 530 (1.9 ms) |
| 4 | 419 | 1030 |
| 8 | 351 | 907 |
| 16 | 366 | 1148 |

**At c=1 Swift is comparable to Bun** (~2 ms cascade — so the cascade WORK,
incl. the row decode + rerank + JSON, is fine). But **Swift throughput
DEGRADES under concurrency while Bun SCALES.** Sequential and tier-parallel
degrade identically, so it is NOT tier execution. The bottleneck is the
**async serving model's concurrency scaling**: `NIOAsyncChannel` + a
per-request `Task` + `runIfActive` offloads + the Swift cooperative executor,
oversubscribed against the NIO event loops, thrash under load. (Contrast:
`/healthz`, served ON the event loop with no offload/Task, scaled to 67k.)

### Verdict — cascade is byte-portable; serving-model suspicion (CORRECTED in slice 3)

The cascade IS portable byte-exact (a real, reusable result — the P7 path
when Bun is gone). The slice-2 hypothesis was that the **SwiftNIO async
serving model** (per-request `Task` + cooperative executor) doesn't scale —
**slice 3 DISPROVES this**: a classic EL-handler degrades identically, so the
serving model is not the cause. See the next section for the corrected
localization. `/search` is inert to production (not wired into
cli.js/ops/Caddy).

---

## Third slice — classic EL-handler + scaling localization — EXECUTED 2026-06-13

### Scope

The slice-2 verdict blamed the async serving model (`NIOAsyncChannel` +
per-request `Task` + cooperative executor). This slice tested that directly by
reverting to the **classic event-loop-confined serving model** — a
`ChannelInboundHandler` (`@unchecked Sendable`, EL-confined — NIO guarantees
`channelRead` + the future callbacks run on the one event loop) running the
cascade in a single `NIOThreadPool.runIfActive(eventLoop:)` offload
(`EventLoopFuture`, no per-request `Task`, no cooperative executor — the model
that scaled `/healthz` to 67k), the response written back on the loop via
`NIOLoopBound`. Then a four-experiment sweep to localize the bottleneck.
Operator authorized the EL-confined `@unchecked` for this experiment.

### The classic handler did NOT fix scaling — but it relocated the bottleneck

`ab -k`, 480-doc corpus, full cascade vs Bun `/search-core`:

| concurrency | Swift classic req/s | Bun req/s |
| --- | --- | --- |
| 1 | **636** (beats Bun) | 574 |
| 4 | 519 | 1057 |
| 8 | 389 | 893 |
| 16 | 390 | 1167 |

The classic handler is **faster than Bun at c=1** (636 vs 574; the async model
was 476) and is the cleaner foundation — but it **still degrades** under
concurrency while Bun scales. So removing the `Task`/cooperative-executor was
not the fix. Four experiments then localized the real cause:

1. **Event-loop count is irrelevant.** Sweeping `--loops` 2/4/6/8/10 at
   c=1/8/16: **identical** (638→389 vs 642→389). The ELG does not bound it.
2. **The serving machinery is NOT the bottleneck.** At c=16, threads=8, a
   query that matches NOTHING (`zzznomatch`) traverses the FULL path (offload,
   pool checkout, 3 SQLite queries returning 0 rows, empty rerank, project
   empty) yet hits **1082 req/s**; `/healthz` (no offload) hits **78,829**.
   Throughput tracks the **FTS matchset size**, monotonically:

   | query (FTS matches) | req/s @ c=16 |
   | --- | --- |
   | zzznomatch (0) | 1082 |
   | metal (~60) | 808 |
   | controller (~120) | 603 |
   | view (~480) | 392 |

   So the cost is the **per-request cascade WORK** (SQLite bm25 scan over the
   matchset + the row decode + rerank + JSON), not the host/offload/EL.
3. **Negative thread scaling.** At c=16 on `view`, **fewer threads = MORE
   throughput**: threads=4 → 514, 6 → 402, 8 → 392, 10 → 406. Adding workers
   makes it worse — the signature of a shared resource, not CPU starvation.
4. **Not the nano allocator.** `MallocNanoZone=0` (disables macOS's nano
   allocator, whose per-magazine locks are the usual small-alloc contention
   culprit) did **not** help — it was slightly worse (c16 353 vs 393), and the
   negative scaling persisted. So the contention is not the nano-zone lock
   specifically.

### Corrected verdict — the residual is the cascade WORK's concurrency-efficiency, not the serving model

The serving model is **fine** (proved four ways: classic ≈ async; zzznomatch
1082; healthz 78k; ELG irrelevant). The residual deficit is that **Swift's
per-request cascade work is less concurrency-efficient than Bun's** under
load. Ruled out: the nano allocator (exp. 4) and SQLite's WAL `-shm` (Bun's
reader pool opens the same file from N workers and scales fine, so shared
`-shm` is not the blocker). Remaining suspects, all per-row and
matchset-correlated *— these were DISPROVEN by the stage isolation below; the
contention is the SQLite scan + host topology, NOT the post-processing —* were:
the String-heavy row decode (~24 `String`s/row), `free`/scalable-zone churn
beyond the nano zone, ARC atomic refcount traffic on the shared static rerank
tables (`BASE_SCORES` dict / `SOURCE_PREFERENCE_ORDER` array, touched per row),
or the `Set<String>` dedup.

**Measurement caveat (honest):** `ab` runs on the SAME 10-core host, so at high
concurrency the client competes with the server for cores — some of the c=1→16
"degradation" is shared-host oversubscription, not purely the server. But Bun
is measured identically and SCALES, so the RELATIVE result (same client, Swift
degrades while Bun scales) is valid; Swift simply extracts less throughput per
core under contention. A clean number needs a separate load-generator host.

### Decision fork (for the operator)

1. **Profile + fix the cascade-work contention** — Instruments (time-profiler
   + allocations/ARC) under concurrent load, or a raw-scan isolation route, to
   pin malloc-vs-ARC-vs-String, then an alloc/ARC-light rewrite of the decode +
   rerank + projection (one byte-buffer copy per row + byte-range columns +
   byte-spanned JSON; immortal/captured scoring tables). The serving model is
   already proven good (wins at c=1), so this is the "make Swift win" path —
   higher effort, promising but uncertain, and partly gated on a clean bench
   host.
2. **Bank the byte-perfect cascade for P7; search serving stays Bun now** — its
   reader pool scales, the SwiftNIO host wins the offload-free routes, and the
   cascade is the only path once Bun is retired (P7), where the contention fix
   can be done against a real corpus. Lower effort; matches the original
   decision tree (NO-GO → stays Bun).

### Sub-decision RESOLVED — reverted to the async no-`@unchecked` model

Operator rule: "keep the `@unchecked` classic handler ONLY if it is measurably
better." A head-to-head settled it — both serving models running the IDENTICAL
one-offload sequential cascade (`--serving classic|async`, since removed),
`ab -k`, byte-identical 27,232 B bodies:

| model | c=1 | c=4 | c=8 | c=16 |
| --- | --- | --- | --- | --- |
| classic (`@unchecked` ChannelInboundHandler) | 619 | 499 | 385 | 385 |
| async (NIOAsyncChannel + per-request Task, no `@unchecked`) | **622** | **512** | **390** | **388** |

**Statistically identical — async is marginally AHEAD.** The earlier "classic
wins at c=1 (636 vs 476)" was a confound: the 476 was the async *tier-parallel*
variant (3 offloads), not async sequential. With identical work the serving
model is irrelevant to throughput, which independently re-confirms the
localization (the cost is the cascade WORK, not the handler). So the
`@unchecked` buys nothing → **reverted to the async model**; `Handler.swift`
(the classic handler) + the `--serving` switch were removed. `ad-server` now
carries no `@unchecked` beyond the contained `StorageConnection`.

### Stage isolation — the actual pin (CORRECTS the String/ARC suspicion above)

The operator chose "pin the cause first." Three diagnostic granularities of the
SAME per-request work were exposed and swept (`/search-rawscan` = the 3 tier SQL
COUNT-only, no decode; `/search-decode` = + the `SearchRow` String decode, no
merge/rerank/JSON; `/search` = full), `ab -k`, threads=8:

| stage | c=1 | c=4 | c=8 | c=16 | c16/c1 |
| --- | --- | --- | --- | --- | --- |
| `/search-rawscan` (SQLite scan only) | 845 | 487 | 394 | 396 | 0.47× |
| `/search-decode` (+ String decode) | 733 | 493 | 385 | 379 | 0.52× |
| `/search` (full + rerank + JSON) | 608 | 507 | 376 | 375 | 0.62× |

**All three converge to ~375–396 at c=16**, regardless of how much Swift work
they do. The decode + rerank + JSON cost shows ONLY at c=1 (845 → 608); at
concurrency the ceiling is identical and sits at/below the **SQLite FTS scan**.
This **disproves the suspects listed above** (the String decode, ARC on the
shared rerank tables, `Set<String>` dedup, the JSONWriter): `/search-rawscan`
does NONE of them and degrades just as hard. So the cascade post-processing is
**not** the concurrency bottleneck, and an alloc/ARC-light rewrite would lift
only the c=1 number, **not** the c=16 ceiling — that fork option is off the
table.

The Bun comparison is fair (apples-to-apples): with no framework filter Bun's
`frameworks = [undefined]` → it runs the SAME 3 unfiltered tier queries
(`cascade.js`; trigram included since `q.length ≥ 3`), not a per-framework
fan-out. So Bun (574 → 1167) genuinely scales while Swift (everything → ~390)
does not, on the SAME 3-scan workload.

**What's left as the cause** is the SQLite read concurrency + the host topology:
Swift's `~390` ceiling is 8 thread-pool threads running the FTS scans on a
10-core box ALSO running 2 event loops, the cooperative pool, the Bun seed, and
— the confound — the `ab` client itself (same-host load competes for cores; the
thread sweep showed threads=4 → 514 > 8 → 392, the oversubscription signature).
Bun's worker-pool topology evidently extracts more throughput per core here.
The honest position: the cascade CODE is exonerated; the residual is a
SQLite-concurrency / thread-topology / same-host-measurement question that a
**clean separate load-generator host** would settle — not something the cascade
rewrite can fix.

Enrichment (snippet/relatedCount/zstd-decompress) is moot until the fork is
chosen. The diagnostic routes (`/search-rawscan`, `/search-decode`) +
`ADStorage.rawScanCount` + `scripts/p6-isolate.mjs` are scaffolding — remove if
the fork is "stays Bun".

### Artifacts

- `swift/Sources/ADServer/{Serving,Main}.swift` — final async NIOAsyncChannel
  serving (no `@unchecked`), one sequential-cascade offload per request; the
  diagnostic `--loops` flag retained. (The classic `Handler.swift` + `--serving`
  switch were added for the head-to-head then removed.)
- `scripts/p6-sweep.mjs` (c-sweep, Swift vs Bun), `p6-loops.mjs` (ELG sweep),
  `p6-alloc.mjs` (match-volume + thread sweeps), `p6-malloc.mjs` (allocator
  attribution). All `ab`-driven on a seeded 480-doc corpus.

---

## Fourth slice — the real bottleneck: a SQLite global mutex (one-line fix) — EXECUTED 2026-06-13

### Scope

The operator asked to design a custom task scheduler / dedicated reader-thread
pool (the records-candidate above) to break the ~390 req/s c=16 ceiling. Plan
mode + research (SE-0417 `TaskExecutor`, `withTaskExecutorPreference`,
`NIOThreadPool` internals, Apple-Silicon QoS via `pthread_set_qos_class_self_np`,
official Apple docs via the apple-docs MCP) produced a measure-first plan: cheap
probes BEFORE building. The probes found the actual cause, which is NOT a
scheduling problem — so the scheduler was never built.

### The hunt (measure-first, each a GO/NO-GO)

- **Phase A — confound check.** Deprioritizing the `ab` client (`taskpolicy -b`)
  did NOT change the gap (0.33→0.34) → not the same-host client; it's
  server-side. `threads=4` (449) > `threads=8` (366) → thread oversubscription
  is involved.
- **Phase B — QoS probe (`--offload gcd`).** Running the cascade on a
  `.userInitiated` `DispatchQueue` (P-cores) instead of NIO's default-QoS pool
  did NOT lift the ceiling (rawscan c16 354 vs 383). **QoS NO-GO** — and since a
  custom pool at high QoS couldn't beat GCD, the scheduler was moot.
- **The profiler (`/usr/bin/sample` under c=16 load) — the breakthrough.** The 8
  reader threads were **~90% blocked in `__psynch_mutexwait`** (2602 samples) and
  only **72** in `sqlite3VdbeExec`. Every blocked stack went through
  `sqlite3Malloc` / `dbMallocRawFinish` / `sqlite3VdbeMemGrow`: **SQLite's global
  memory-statistics allocator mutex.** With `SQLITE_CONFIG_MEMSTATUS` ON (the
  default), every malloc/free takes a global mutex to update counters →
  alloc-heavy FTS queries serialize all reader connections on one lock. Bun
  doesn't hit it because `bun:sqlite` disables memstatus.

### The fix

`sqlite3_config(SQLITE_CONFIG_MEMSTATUS, 0)` once at loader init, before the
first open (`ADStorage/SQLiteLib.swift`). `sqlite3_config` is variadic and
cannot be called correctly through a fixed `@convention(c)` pointer on arm64
(the trailing arg must go on the stack), so a 6-line C shim (`CSQLiteShim`)
calls the dlsym'd pointer with the right ABI. No custom scheduler, no
`@unchecked`, parity unchanged.

### Results — `ab -k`, the SQLite-fix is decisive

**Synthetic 480-doc corpus (alloc-bound — the FTS index fits in cache, so the
cost is allocation):**

| stage @ c=16 | before (memstatus ON) | after (OFF) |
| --- | --- | --- |
| `/search-rawscan` | 383 (0.45× scaling) | **2324 (2.51×)** |
| `/search` (full) | 379 | **2263 (3.50×)** |

Swift `/search` went from degrading-under-load to **scaling positively**, ~6× at
c=16, and now ~**2× Bun** (Bun 1149). The P6 inversion win — in-process native
serving beats the Bun worker pool — achieved, from one config call.

**Real 4GB corpus (page-cache/scan-bound — ~18 ms/query):**

| `/search` @ c=16 | memstatus ON | OFF (fix) | Bun |
| --- | --- | --- | --- |
| req/s | 27 | **51** | 58 |

The fix still **~2×'s** throughput (27→51) and **stops the degradation**, bringing
Swift to **parity with Bun (51 vs 58)**. The 6× synthetic win shrinks to 2×
because the real corpus exposes a **SECOND global mutex** (below) that caps both
runtimes.

### The second mutex (documented; deferred — it caps Bun too)

On the real corpus, with memstatus OFF, the threads are STILL ~90% in
`__psynch_mutexwait` — but now via **`pcache1Fetch` / `getPageNormal` /
`pcache1Unpin`**: SQLite's **pcache1 page-cache group mutex**. It is shared
across connections when libsqlite3 is built with `SQLITE_ENABLE_MEMORY_MANAGEMENT`
(Homebrew's build is; without it each connection gets a private cache group and
no contention). The tiny synthetic corpus stayed fully cached so never showed it;
the 4GB corpus churns pages constantly. **Deferred** because it caps Bun (~58)
too — it is not a Swift-vs-Bun gap, and Swift already reaches parity. **Future
lever:** dlopen macOS's *system* libsqlite3 (likely built without
memory-management → per-connection cache → no group mutex) instead of Homebrew's
— but the candidate order prefers Homebrew for its FTS5 guarantee, so this needs
an FTS5-presence check on the system lib first (portability). Tracked as a
P6/P7 storage optimization.

### Verdict — custom scheduler OBSOLETE; the ceiling was a SQLite config

The entire "build a custom task scheduler" plan is **unnecessary**: the ~390
ceiling was never a Swift scheduling/QoS problem — it was SQLite's default global
allocator mutex. One `sqlite3_config` call makes Swift scale positively and beat
(synthetic) or match (real corpus) Bun. **TSan-clean** under 800 concurrent
searches; parity 10/10. The probe scaffolding (`--offload`, `/search-rawscan|
-decode`, `rawScanCount`, the env toggle, the one-off probe scripts) was removed;
`ADStorage` keeps the fix + `CSQLiteShim`. `/search` stays inert to production.

### Artifacts (fourth slice)

- `swift/Sources/CSQLiteShim/` (the variadic-ABI shim) +
  `ADStorage/SQLiteLib.swift` (the `memstatus_off` call) — the keeper.
- `scripts/p6-sweep.mjs` — the surviving Swift-vs-Bun harness.
- Plan: `~/.claude/plans/bubbly-cuddling-dream.md` (the custom-scheduler plan,
  obsoleted by this finding).

---

## Fifth slice — enrichment (snippet + relatedCount) → FULL byte-parity — EXECUTED 2026-06-13

First slice of "complete the Swift `/search`" (the remaining JS `search()` gap).
Ported the hot-path enrichment (`src/commands/search.js:309-326`): after the
page slice, `getDocumentSnippetData` + `getRelatedDocCounts` (batched, ported to
`ADStorage/Enrichment.swift`) feed `renderSnippet` (`ADSearchCascade/Snippet.swift`),
populating `snippet` + `relatedCount` on each hit. The parity test now compares
**WITHOUT stripping** those fields — **byte-identical (11/11)**.

Reuse + correctness:
- **`renderPlainText` reused** — `ADContent.PlainText.render` (the P4-validated
  span renderer) via a one-buffer/spans bridge; no re-port.
- **Section codec** (`src/storage/section-codec.js`): type-directed — a TEXT
  cell passes through, a BLOB with the 4-byte zstd magic is inflated via the new
  **`ADArchive` decompress binding** (`ZSTD_decompress` + `ZSTD_getFrameContentSize`,
  `ZstdDecoder`). Validated end-to-end (a zstd-compacted seed section round-trips
  identically on both sides).
- **Snippet windowing** replicates JS string semantics exactly — UTF-16 indices
  for indexOf/slice/length, `JsString.lowercase`/`trim`, `Math.floor(maxLength *
  0.35)` as the same IEEE op. Test exercises both `...` ellipses.
- **Best-effort semantics matched**: a missing `document_relationships` table →
  `getRelatedDocCounts` returns nil → the whole block is skipped (neither field
  emitted), exactly like the JS try/catch where the unguarded query throws.

Deps: `ADStorage`→`ADArchive` (zstd, dlopen — dylib stays zero-external-dep);
`ADSearchCascade`→`ADContent` (PlainText/JsString; server-only). Perf no-regress:
Swift `/search` with full enrichment c=16 **1864 rps** (vs 2263 phase-1; ~18% for
2 batched queries + 100 snippet renders/req) — still scales 4.6× and beats the
(enrichment-skipping) Bun reference (1131). All 57 native tests + `swift test`
green. Next slices (open): fuzzy T3 + body T4, relaxation, filters + synonyms.

---

## Sixth slice — `/search` COMPLETED (tiers + relaxation + filters + synonyms) — EXECUTED 2026-06-14

The remaining JS `search()` gap, ported byte-exact in parity-gated commits — the
Swift `/search` now matches `projectSearchResult(search(opts,ctx))` for the full
lexical pipeline (semantic/vector tier still out of scope). Parity grew to
**34/34** (15 plain + 19 filtered queries):

- **Body T4** (`searchBodySQL` on `documents_body_fts`, merged when T1+T2 < window).
- **Fuzzy T3** (`lib/fuzzy.js`): trigram-OR bm25 candidates + Levenshtein (≤2,
  early-exit, UTF-16) → matchQuality `fuzzy` → `approximate` confidence + the
  envelope `approximate` flag.
- **Relaxation R1-R3** (`cascade.js` + `relaxation.js`): pruned-AND → pruned-OR →
  trigram-on-token when the strict+deep tiers return nothing on a ≥3-token,
  ≥4-char, unquoted query (`relaxed*` matchQualities; `relaxed`/`relaxationTier`
  are not projected).
- **JS post-filters** (`filters.js`): `matchesSearchFilters` — kind taxonomy,
  platform-version (the `'0'` sentinel reads `platforms_json` keys via
  `ADBase.Json`, else `compareVersions`), language, source, deprecated, metadata
  — applied at every merge point, layered on the SQL `FILTER_PREDICATES` (filter
  bag parsed in `QueryParse`/`prepare`, 3× over-fetch when kind/platform active).
- **Framework-synonym fan-out** (`getFrameworkSynonyms`): each tier (strict +
  body + relaxation; not fuzzy) runs once per framework (canonical + synonyms),
  concatenated.

Reuse: `ADContent.PlainText` (snippet), `ADBase.Json` (platforms_json),
`FtsQuery`/`Rerank`/`Intent`, `JsString`/`CaseFolding`. Deep tiers gated
(results<5 / <window / ==0), so the hot path (a full window) never runs them.
All 80 native tests + `swift test` green. `/search` stays inert to production
(not wired into cli.js/ops/Caddy) until the web slice. Remaining P6: MCP protocol
(SDK+zod kill) + web routes/wiring; deferred storage perf (pcache mutex).

---

## Seventh slice — web API backend (the cheap routes) — EXECUTED 2026-06-14

`ad-server` grew from `/healthz`+`/search` into a real web backend by porting the
**13 cheap, corpus-derived `/api/*` + `/data/*` + discovery routes** from the Bun
web server (`src/web/`). Five commits (`91fc3e6` → `cf0c813`); 19 parity cases +
`swift test` green; inert to production (Caddy/launchd flip operator-gated).

### Routes (all matched to the Bun handlers)

- **Response foundation** (`WebResponse.swift`): every response now carries the
  constant security-header set (`context.js:231-239`) + RFC 8288 `Link` + `Vary:
  Accept` + a minted `X-Request-Id`, and a `hashable` response gets a SHA-256-prefix
  `ETag` with a 304 on `If-None-Match` (`responses.js:finalizeResponse`). The
  dispatch is a `switch` in `Serving.swift` + three pattern matchers (symbol
  metadata, hashed search artifact, framework tree).
- **API**: `/api/filters` (3 facet queries), `/api/fonts` + `/api/fonts/faces.css`,
  `/api/symbols/{index.json, search (FTS5+LIKE fallback), <scope>/<name>.json}`.
- **Data**: `/data/search/{search-manifest.json, title-index[.<hash>].json,
  aliases[.<hash>].json}`, `/data/frameworks/<slug>/tree.<hash>.json`.
- **Discovery**: `/robots.txt`, `/opensearch.xml`, `/.well-known/api-catalog`,
  `/.well-known/mcp/server-card.json` (pure siteConfig builders, plumbed via flags).
- **Health**: `/readyz` (instance-identified, not parity-gated).
- New ad-server deps: `apple/swift-crypto` (SHA-256) + `g-cqd/ADJSON` (below). The
  `libAppleDocsCore` dylib stays zero-external-dep.

### Two operator-directed reframings (the substance of this slice)

1. **JSON engine → ADJSON (`g-cqd/ADJSON`), fully.** The byte-exact JS-`stringify`
   need first drove a hand-rolled writer; mid-slice the operator pointed at ADJSON,
   their tape-based JSON engine. ADJSON's public emit API didn't yet fit the
   byte-exact "ordered + raw-splice" requirement, so a **`JSONStreamWriter`** SPI was
   **co-designed with the ADJSON team** (the JS-`JSON.stringify` byte-parity profile:
   ECMA-262 numbers, `nil`-omit, `raw`/`rawOrEmptyArray` splice, `consuming finish()`)
   and shipped to ADJSON `main`; ad-server adopted it (the interim writer was deleted).
2. **Parity = INTRINSIC, not byte (D2).** The operator then relaxed the gate from
   byte-identity to **deep-equal on the parsed JSON** (object key order / whitespace
   / serialization are free; array order + null-vs-omit stay semantic; text routes
   stay byte; hashed artifacts assert internal coherence, not hash==JS). This
   **unlocked ADJSON's Codable models NOW** (not post-Bun): fixed shapes →
   `Encodable` structs via `ADJSON.JSONEncoder`; dynamic / null-emitting / full-row
   shapes (the alias map, framework-tree `docs`, the full SF-Symbol row) →
   **`ADJSON.JSONValue`** (the stored `*_json` columns parsed via `JSONValue(parsing:)`
   and embedded). `JSONStreamWriter` is no longer needed for routes. Found along the
   way: synthesized `Encodable` OMITS nil Optionals (JS `undefined`), so `null`-emit
   fields go through `JSONValue.null`, not `T?`.

### Gate + state

`test/unit/native/web-routes-parity.test.js` boots `ad-server` against a seeded
corpus and diffs each route vs the imported Bun handler — **JSON deep-equal
(intrinsic), text byte-exact, + the deterministic headers (Content-Type /
Cache-Control / ETag) + the manifest↔artifact hash coherence**. 19 cases; the
`/search` cascade parity (34) is unchanged. ADStorage gained the typed queries
(`Filters`/`Assets`/`SearchArtifacts`/`FrameworkTree`.swift) — the model seam.

**Remaining P6:** the live flip — a Caddy upstream-split (route `/api/*` [except
`fonts/file|family|subset`] + `/data/*` + discovery to `127.0.0.1:3032`) behind an
`APPLE_DOCS_NATIVE` stanza + an `ad-server` launchd unit, **operator-gated** (the
slice is wired-ready but not enabled). Optional: retrofit the committed
filters/discovery-JSON routes from `JSONStreamWriter` → models (one server-wide
approach). Still open: the MCP protocol (SDK+zod kill); the pcache1 storage perf.
`safeWebDocKey` ships identity (≤200-byte keys); the oversized-segment SHA-1
mapping is noted-unported (rare).
