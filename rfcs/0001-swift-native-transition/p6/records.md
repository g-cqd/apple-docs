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

### Verdict — cascade is byte-portable; the SwiftNIO ASYNC serving model doesn't scale

The cascade IS portable byte-exact (a real, reusable result — the P7 path
when Bun is gone). But the **SwiftNIO async-offload serving model does not
scale under concurrency** for these DB-bound requests; tier-parallelism is a
red herring. Two paths remain: (1) a **lower-overhead serving model** — the
classic `ChannelInboundHandler` + `EventLoopFuture` offload (no per-request
`Task`/cooperative-executor, EL-confined; needs the EL-confined `@unchecked
Sendable` the operator discouraged) which scaled for healthz and may scale
here; or (2) **accept that search serving stays Bun** — its reader pool is
already good, the SwiftNIO host wins only the offload-free routes (healthz),
and the byte-perfect cascade waits for P7 (single binary, no Bun, where it's
the only path). Enrichment (snippet + renderPlainText + relatedCount + zstd-
decompress) is moot until that's decided. `/search` is inert to production
(not wired into cli.js/ops/Caddy).
