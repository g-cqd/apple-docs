# RFC 0001 — Swift-native transition

- **Status**: Draft (living document)
- **Audience**: maintainers. This RFC lives in `rfcs/` deliberately — it is
  repo documentation, not product documentation, and is not built or indexed
  by the docs site.

## 1. Goals and non-goals

**Goals**

- Migrate apple-docs from a Bun/JavaScript codebase to a **fully Swift-native
  one**, incrementally, without ever breaking the shipped feature set.
- **Performance**: native code on the hot paths (search ranking, embedding
  inference, content conversion, archive packing) with explicit benchmarks
  gating each step — Swift must match or beat the JS implementation it
  replaces before the JS is deleted.
- **Security / supply-chain minimalism**: third-party Swift dependencies are
  restricted to a small set of trusted organizations (§2); everything else is
  implemented in-house or linked from OS-provided system libraries.
- **Reliability**: strict concurrency, typed errors, memory safety, and a
  per-module kill switch back to the JS implementation until the very end.
- **Interoperability**: first-class Linux (x86_64 + aarch64) alongside macOS,
  with Windows as an explicit later phase. The Linux parity work that landed
  ahead of this RFC (hb-view text rendering, offline-mode defaults, SQLite
  boot hardening) defines the bar: 100% of the feature set on both OSes.

**Non-goals**

- No big-bang rewrite. Every phase ships behind parity gates on `main`.
- No format changes DURING a swap: the corpus database schema, snapshot
  archives (`.tar.zst`, determinism gate included), CLI surface, MCP tool
  contracts, and web routes stay byte-compatible through each migration.
  A Swift module port is an implementation swap, never a behavior change.
  **Deliberate improvements come AFTER parity as separate evidence-gated
  slices — the §10 improvement track owns those (including re-embeds and
  format changes, each under its gate category).**
- No new product features ride along with a migration phase. (Product
  improvements have a sanctioned home: §10.)

## 2. Dependency policy

Swift package dependencies are allowed **only** from:

| Org | Examples we expect to use |
| --- | --- |
| `apple/*` | swift-nio (+ssl/+http2), swift-argument-parser, swift-collections, swift-crypto, swift-system, swift-atomics, swift-async-algorithms, swift-http-types, swift-log |
| `swiftlang/*` | swift-markdown, swift-cmark, swift-syntax, swift-format, swift-docc-symbolkit, swift-testing (toolchain) |
| `pointfreeco/*` | swift-parsing, swift-dependencies, swift-custom-dump, swift-snapshot-testing, swift-case-paths |

**Vetted exceptions**: anything outside these orgs requires an explicit
decision recorded in §9. The previously-named *Vapor* candidate is
**withdrawn (operator decision 2026-06-12, §9 D1)**: the server phase is
fully custom — an in-house HTTP layer directly on SwiftNIO — and the
dependency universe stays apple/* + swiftlang/* + pointfreeco/* (+ the §2
system C libraries) only. The exception MECHANISM remains for future
cases.

**System C libraries** (linked via module maps, not package dependencies)
are allowed: `sqlite3`, `zstd`, and — on Linux — `harfbuzz`/`freetype` for
the text-shaping module. These are OS-distribution-trust, pinned by the
container/base-image digest in CI rather than by a package manager.

Toolchains are pinned (swiftly + `.swift-version`), `Package.resolved` is
committed, and CI fails on resolution drift.

## 3. Current state (inventory, June 2026)

~44.5k LOC JavaScript across `src/` (+ `ops/`, `scripts/`, 200+ test files).

| Module | LOC | Notes for migration |
| --- | --- | --- |
| web/ | 11.4k | `Bun.serve` listener, 353k-page static builder, worker fan-out, shiki highlighting |
| commands/ | 5.3k | CLI verbs; snapshot build (VACUUM INTO + tar.zst) |
| storage/ | 4.4k | **All `bun:sqlite` usage confined to `database.js` (13 call sites)** + reader-pool worker threads |
| resources/ | 4.2k | SF Symbols + fonts; **5 inline Swift scripts already (725 LOC)** spawned JIT via `Bun.spawn` |
| sources/ | 3.7k | 12 source adapters (pure JS, network + parsing) |
| content/ | 3.6k | DocC JSON → Markdown/HTML converters; highlight via shiki |
| lib/ | 4.0k | archive-zstd, hashing, fuzzy, link resolver |
| mcp/ | 2.2k | `@modelcontextprotocol/sdk` server + tools |
| search/ | 1.9k | ranking/fusion math, model2vec embedder (transformers.js + onnxruntime), eval metrics |
| pipeline/, cli/, apple/, output/ | 3.7k | crawl/persist, help/formatters, renderer wrapper, projections |

**Runtime dependencies to eliminate** (the entire third-party JS surface):

1. `@huggingface/transformers` + `onnxruntime-*` — **scoped-DONE
   2026-06-11 (RFC 0002 Stage C)**: the default model runs the from-scratch
   Swift pipeline exclusively (bit-exact, proven over 831k chunks); the
   deps remain optionalDependencies used ONLY by gated non-default
   experiment models (D-0002-4) and leave entirely when those are dropped
   or get Swift inference.
2. `shiki` — syntax highlighting in `content/highlight.js`.
3. `@modelcontextprotocol/sdk` — MCP server plumbing; the protocol
   (JSON-RPC 2.0 over stdio / Streamable HTTP) is small and we already
   constrain it heavily (stateless HTTP, compact serialization).
4. `zod` — schema validation at the MCP boundary; replaced by Swift
   `Codable` + generated JSON Schema at the very end (P6).

**Bun APIs in use** (replaced last): `bun:sqlite`, `Bun.serve` ×2,
`Bun.spawn`/`spawnSync`, `Bun.file/write`, `Worker` reader pool,
`bun build --compile` for release binaries. No `bun:ffi` yet — the bridge
introduces it.

**Existing parity harness** (reused as migration gates): golden search eval
(NDCG/MRR over 355 judged queries, `test/golden/`), benchmark suite with
`--record` history (`test/benchmarks/`), snapshot determinism gate (CI
double-build + sha256 diff), 2,400+ unit/integration tests.

## 4. Bridge architecture (the transition mechanism)

```
┌────────────── Bun process ──────────────┐
│ JS module (unchanged public API)        │
│   └─ native.js shim                     │
│       ├─ APPLE_DOCS_NATIVE gate ────────┼─→ JS implementation (kill switch)
│       └─ bun:ffi → dlopen ──────────────┼─→ libAppleDocsCore.{dylib,so}
└──────────────────────────────────────────┘        └─ swift/ SwiftPM package
```

- **One SwiftPM package** at `swift/` producing `libAppleDocsCore` (dynamic
  for the bridge era; static-linked into the final binary in P7). Products
  are per-platform artifacts: `darwin-arm64` (dylib alone), `linux-x64` and
  `linux-arm64` (glibc `.so` + bundled Swift runtime set, rpath `$ORIGIN` —
  see §5 correction).
- **C ABI boundary**: `@_cdecl` exports with length-prefixed byte buffers
  (UTF-8 JSON for cold/complex payloads, packed structs/Float32 arrays for
  hot ones — embedding vectors, ranking inputs). Every export returns a
  status code + result buffer; Swift never throws across the boundary.
  Allocation contract: Swift allocates, JS copies, JS calls `ad_free(ptr)`.
- **Kill switch**: `APPLE_DOCS_NATIVE` env — unset = current default for
  each module's rollout stage; `=0` forces JS everywhere;
  `=mod1,mod2` opt-in per module. Every shim logs which side served. The JS
  implementation is deleted only after a full release cycle at
  native-by-default with no regressions.
- **Parity gates per module** (CI-enforced):
  1. A/B test run: the module's unit tests execute against BOTH
     implementations (the shim exposes `_forceImpl` for tests).
  2. Golden gates where applicable: search eval NDCG/MRR must not drop;
     snapshot bytes must stay deterministic; rendered SVG/Markdown
     fixtures diff clean (`swift-snapshot-testing` mirrors on the Swift
     side, `swift-custom-dump` for structural diffs).
  3. Benchmarks: `test/benchmarks/` thresholds — native ≥ JS or the phase
     does not ship.
- **Distribution during the bridge**: the dylibs are built in CI and
  attached to snapshot releases next to the existing binaries; `setup`
  fetches the right artifact (sha256-pinned like the embedding model).
  Absent dylib = JS fallback, never a failure.

## 5. Toolchain and cross-compilation

> **Corrected 2026-06-11 by the P0 research**
> ([`p0/`](0001-swift-native-transition/p0/README.md), experiment E6): the
> Static Linux SDK (musl) supports **no dynamic linking** — it cannot emit
> the `.so` the bridge era needs — and `--static-swift-stdlib` is not
> honored for shared-library products either. The musl SDK returns in P7
> for the single static executable.

- **Swift 6.3.x pinned** (current stable; `.swift-version` in-repo, swiftly
  honors it); upgrades are their own PRs (D-P0-2).
- **Linux**: plain glibc dynamic builds, made **natively on Linux runners**
  (`ubuntu-latest` x64, `ubuntu-24.04-arm` arm64), shipped as a
  self-contained bundle: the `.so` linked with rpath `$ORIGIN` plus the
  stripped Swift runtime `.so` set beside it (9.4 MB stdlib-only → 16 MB
  with FoundationEssentials → 61 MB with full Foundation/ICU; glibc floor
  2.17). Verified end to end under `oven/bun` with no Swift on the host
  (D-P0-1). `apple/swift-sdk-generator` (glibc cross-compile from macOS)
  stays a developer convenience, not the artifact path.
- **macOS**: `swift build -c release`; the OS ships the Swift runtime, the
  arm64 linker ad-hoc signs. darwin-arm64 first; universal only when the
  bun-binary matrix grows x86_64.
- **Windows**: explicitly later (P8+); Swift's Windows toolchain is
  workable but our renderers and ops layers assume POSIX today. Tracked,
  not planned.
- **CI**: a `swift-ci` job matrix (macos-26 + both ubuntu runners) running
  swift-format lint, `swift test` (swift-testing), and the native builds;
  `.build` cached on the package manifests. Full design:
  [`p0/ci.md`](0001-swift-native-transition/p0/ci.md).

## 6. State-of-the-art Swift guidelines

- **Strict concurrency** (`-strict-concurrency=complete`): actors own
  mutable state (DB writers, render workers, caches); `Sendable` enforced;
  no `@unchecked` without a recorded justification.
- **Typed throws** for module-internal error domains; a single
  `ADError` enum crosses the C ABI as status codes.
- **Hot-path memory discipline**: `Span`/`RawSpan` and `~Copyable` types for
  zero-copy buffer handling (Swift 6.2), `InlineArray` where shapes are
  fixed (embedding dims), `Synchronization.Mutex`/`Atomic` over locks.
- **SIMD/Accelerate**: vector math through `simd`/portable SIMD on Linux,
  Accelerate (vDSP/BNNS) on darwin behind a uniform internal API.
- **Foundation**: `FoundationEssentials` only on Linux (no ICU dependence
  in hot paths); `URLSession` (FoundationNetworking) for the crawler — it
  is curl-backed on Linux and keeps us inside the allowed orgs.
- **pointfreeco toolkit**: `swift-parsing` for DocC payload / plist / SFNT
  parsing (replacing ad-hoc parsers), `swift-dependencies` for seams,
  `swift-snapshot-testing` + `swift-custom-dump` for the parity harness.
- **Testing**: swift-testing (`@Test`, parameterized), fuzzing harnesses
  (libFuzzer targets) for every parser that consumes external bytes
  (DocC JSON, SFNT, PDF glyph streams, tar headers).
- **swift-format** enforced in CI (the Swift mirror of the biome gate).

## 7. Phases

Every phase lists: scope → dependencies killed → gates. Rollback is always
the `APPLE_DOCS_NATIVE` kill switch; phases are independently shippable.

### P0 — Toolchain, CI, FFI skeleton — **DONE (2026-06-11)**
`swift/` package (ADBase common bases + ADSearch + ADCore →
`libAppleDocsCore`), `src/native/loader.js` +
`APPLE_DOCS_NATIVE`/`APPLE_DOCS_NATIVE_LIB`, the three-target `native` CI
job (macos-26 / ubuntu-latest / ubuntu-24.04-arm: build, swift test, staged
$ORIGIN bundle, JS↔Swift parity). All gates met. ABI contract v0 + the
loader/CI/security/boundary research live in
[`p0/`](0001-swift-native-transition/p0/README.md).

### P1 — Leaf hot functions — **DONE / CLOSED (2026-06-11)**
Fusion math (`ADSearch`, `Object.is`-exact vs `fusion.js`: 400 seeded
property cases + fixtures) + the tar.zst archiver (`ADArchive`, runtime-
dlopen'd libzstd, no host binaries, pax-complete: a 273k-file tree
verified) shipped behind the kill switch (`fusion`, `archive`). Content
hashing dropped from P1 (Bun's CryptoHasher already native).
**Ranking + snippets stay JS for the bridge era by measurement** — NOT an
exemption: they migrate with P6's orchestrator move (inside the Swift
process the FFI tax disappears). `rerank` is 158.8 µs at the maximum
realistic input = **0.04%** of a 372 ms lexical query; an FFI port would be
marshalling-bound (the fusion n=10 lesson) and must reproduce exact JS
double semantics — all risk, no win. Snippets + highlighting close with it.
See §9.

### P2 — Embedder — **COMPLETE** → [RFC 0002](0002-swift-embedder.md)
model2vec inference in `ADEmbed`, native-by-default (`embed` token);
Stage-C kills executed (transformers/onnxruntime gated-only, snapshots ship
the ADMX artifact instead of model.onnx); embedding v2 + the reference flip.
*Killed* (default model): `@huggingface/transformers`,
`onnxruntime-node`/`-web`, the WASM fallback, the darwin-x64 gap. Detail +
records in RFC 0002.

### P3 — Render service — **Phases 1/2/4 DONE; phase 3 held** → [RFC 0003](0003-swift-render-service.md)
darwin font-text + symbol-pdf + symbol-png + the symbol prerender, all
native-by-default (`render` token, warm 163×/1497× over the JIT spawn; the
prerender batch 2.0× over the worker pool). The Linux HarfBuzz shaper
(dlopen'd libharfbuzz) **dropped the hb-view host binary**. *Remaining*:
phase 3 — delete the darwin spawn scripts, gated on a release cycle at
native-default (they are the `=off` escape hatch's fallback). Detail +
records in RFC 0003.

### P4 — Content pipeline — **Main line DONE; phases 3-4 NO-GO** → [RFC 0004](0004-content-pipeline.md)
markdown/plaintext renderers native + default-on (`content` token, tape
parser + parallel batches; byte-proven at 358k-doc scale, 2–3.2× batched).
**Phases 3-4 closed NO-GO** by the static-build CPU profile (84% filesystem
IO + 6.5% SQLite; render surfaces ~6%, mostly shiki WASM — a port can't move
build wall-time). *Killed*: nothing (shiki stays; swift-markdown NOT adopted,
D-0004-4). *Remaining*: phase 3 (crawl-time normalize) — separate,
independently gated. Detail + records in RFC 0004.

### P5 — Storage — **Foundation shipped (token-gated OFF); bridge flip NO-GO** → [p5 records](0001-swift-native-transition/p5/records.md)
SQLite C-interop via runtime-dlopen'd libsqlite3 (D4 settled: raw C interop,
NOT swift-structured-queries; dlopen, NOT a systemLibrary — the Zstd policy).
First slice EXECUTED 2026-06-13: the durable read foundation (`ADStorage` —
dlopen binding, read connection, prepared-stmt cache, type-tagged row codec,
handle registry) + `searchPages` ported end-to-end behind the bridge, served
inside the `worker_threads` pool. **A/B byte-parity PASS** (bm25 `rank`
bit-identical across SQLite builds) and **WAL coexistence PASS** (native
readers + the live bun:sqlite writer, no SQLITE_BUSY, bounded WAL) — but the
**concurrency gate is NO-GO**: native is ~7-16% SLOWER per call. bun:sqlite
is already native C SQLite, so the FFI pack+frame+decode is pure boundary tax
(the P4 "P7 corollary"); the architectural win is P6/P7-coupled (no FFI, rows
born in Swift memory). So `storage` stays **default-OFF** (opt-in token); the
foundation is the **P6 prerequisite** — a SwiftNIO server can't call
bun:sqlite. *Remaining (P6/P7-coupled)*: the other 12 read ops, the
reader-pool→native-actors move, and the *kills* (`bun:sqlite`, the `Worker`
pool — unkillable while Bun is runtime + writer). Detail:
[p5/records.md](0001-swift-native-transition/p5/records.md).

### P6 — Servers (fully custom, in-house on SwiftNIO) — **host GO + cascade byte-exact; search serving-win blocked on a cascade-work concurrency fix (fork open)** → [p6 records](0001-swift-native-transition/p6/records.md)
> **D1 settled 2026-06-12 (operator decision)**: no Vapor — the spike is
> cancelled. The web + MCP HTTP layer is built from scratch directly on
> SwiftNIO (+ swift-http-types/swift-nio-ssl as needed), keeping the
> dependency universe at apple/* + swiftlang/* + pointfreeco/* only.

**First slice EXECUTED 2026-06-13 (host spike)**: a standalone `ad-server`
(first SwiftPM dep, `apple/swift-nio`; max strict concurrency, TSan-clean, no
`@unchecked` beyond the contained C handle) serving `/healthz` + `/search`
over ADStorage in-process. **Host GO** — SwiftNIO healthz 67k req/s (≥
Bun.serve), no event-loop stall, query parity-fine (~1.16× bun:sqlite). **But
single-query `/search` is ~2.5× SLOWER than the Bun worker pool** (`ab`):
the per-request async-offload overhead (~0.3 ms of executor hops) rivals the
tiny query (~0.3 ms) and dominates. The inversion win needs amortizing one
offload over the FULL cascade (4 tiers + ranking + fusion in-process,
killing Bun's *per-tier* worker round-trips), so **the next slice ports the
cascade and re-measures full-search vs full-search** (or evaluates a
lower-hop serving model). Do NOT do a naive per-op port. Detail:
[p6/records.md](0001-swift-native-transition/p6/records.md).

**Second + third slices EXECUTED 2026-06-13 (lexical cascade + scaling
localization)**: the JS lexical cascade (T1+T2, merge, intent, rerank,
projection) ported **byte-exact** into a Swift `/search` (new server-only
`ADSearchCascade`; ADStorage gained `SearchRow` + tier queries) — **10/10
byte-parity** (the projection strips floats → labels, so parity is ordering +
fields; rerank scores are bit-identical). The classic EL-confined handler is
**faster than Bun at c=1** (636 vs 574 req/s) but **degrades under
concurrency** while Bun scales. Four experiments localized this OFF the
serving model (a 0-match query runs the full offload path at 1082 req/s @ c16,
healthz 78k, ELG 2–10 identical, classic ≈ async) and OFF the nano allocator
(`MallocNanoZone=0` no help) and SQLite `-shm` (Bun shares the file fine): the
residual is Swift's String/ARC-heavy decode+rerank+JSON being **less
concurrency-efficient than Bun's per-isolate runtime** (negative thread
scaling). **Fork open**: profile + alloc/ARC-light rewrite ("make Swift win")
vs search serving stays Bun with the byte-perfect cascade banked for P7. The
host, the in-process cascade, and the bench harness ship inert (not wired into
cli.js/ops/Caddy).

Implementation (remaining): web server (routes are already per-file handlers
— port them 1:1; benchmark throughput/latency on our recorded burst loads vs
`Bun.serve` baselines, incl. the §10(C) burst-stall findings), MCP server
with the protocol implemented in-house (JSON-RPC 2.0, stdio + stateless
Streamable HTTP, tool schemas as `Codable` + generated JSON Schema). *Kills*:
`@modelcontextprotocol/sdk`, `zod`, `Bun.serve`. *Gates*: MCP contract
tests (tool-budget bytes, pagination geometry) green; web smoke + UI
audit green; burst benchmarks ≥ Bun baselines on both OSes.

### P7 — CLI, ops, single binary
swift-argument-parser CLI mirroring `cli.js` verb-for-verb; ops layer
ports (launchd/systemd plumbing is mostly exec + file templating); release
pipeline emits ONE static binary per platform (Swift), bun binaries
sunset after one overlap release. *Kills*: Bun runtime, `package.json`
runtime deps entirely. *Gates*: `verify-profiles` matrix green against
the Swift binary on macOS + Linux; ops smoke on the public instance.

### Sequencing

P0 → P1 → P2 ship serially (each ~independent value). P3/P4 can proceed in
parallel after P1. P5 starts once P2 + P3-**darwin** are native-by-default
(the Linux shaper is deferred per RFC 0003 and does not gate P5). P6 after
P5. The LIVE sequencing — parallel tracks, the improvement slices of §10,
and the deferred-Linux bucket — is maintained in [rfcs/README.md](README.md).
P7 last. At every point `main` is releasable and the snapshot cadence is
untouched.

## 8. Risk register

| Risk | Mitigation |
| --- | --- |
| FFI marshalling eats the native win on chatty paths | Batch boundaries (P1 design rule: one call per query, not per document); packed buffers for hot data; benchmarks gate every phase |
| Two-runtime debugging is painful | Impl logging on every shim; `APPLE_DOCS_NATIVE=0` reproduces any bug on pure JS; parity tests pin behavior before perf work |
| Linux text shaping fidelity (P3) | HarfBuzz is the industry shaper; fixture-diff against CoreText output with tolerance rules; hb-view path already proved the pipeline |
| Linux runtime-set weight (61 MB with full Foundation) | Keep P1 modules stdlib-only (9.4 MB set); FoundationEssentials, not the umbrella, when Foundation becomes unavoidable (16 MB, no ICU) — measured in P0 research E6 |
| Contributor onboarding (Swift + JS during bridge) | Module map in this RFC stays current; one module = one owner-of-record during its migration |
| swift-testing / toolchain churn | Pinned toolchains; upgrades are their own PRs, never inside a phase |
| CI cost (3 platform targets × A/B suites) | Native Linux runners are free for public repos (incl. arm64); Swift lane gated on `swift/**` paths per PR, full matrix on snapshot runs; A/B only on touched modules per PR, full matrix nightly |

## 9. Decision log / open questions

| # | Question | Status |
| --- | --- | --- |
| D1 | Server framework: Vapor (vetted exception) vs SwiftNIO-direct | **SETTLED 2026-06-12 (operator decision): fully custom in-house on SwiftNIO — no Vapor, no spike; deps stay apple/swiftlang/pointfreeco only (§2)** |
| D2 | Highlighting engine for non-Swift languages (TextMate in-house vs tree-sitter exception vs reduced set) | **Moot** while P4 phase 4 is shelved (NO-GO, RFC 0004 + records); re-opens only if P6/P7 serves HTML in-process |
| D3 | Windows timing | Deferred until after P7 |
| D4 | swift-structured-queries (pointfreeco) for the storage query layer vs raw C interop | **SETTLED 2026-06-13 (P5 first slice): raw C interop** over runtime-dlopen'd libsqlite3 — parity needs the byte-identical hand-tuned FTS5 SQL; a builder risks divergence + a dep. A builder re-opens only if queries get rewritten post-parity (§10). Records: [p5](0001-swift-native-transition/p5/records.md) |
| D5 | Dylib distribution vs build-from-source for `setup` consumers | **Settled by P0 research (2026-06-11)**: artifacts-in-release with sha256 sidecars; compiled binaries embed the dylib (`dlopen` accepts the embedded path directly); Linux ships `$ORIGIN`-rpath runtime bundles. Details: [`p0/decisions.md`](0001-swift-native-transition/p0/decisions.md) D-P0-1/9/10 |

## 10. Beyond parity — the improvement track

The bit-identical discipline of §4 is the TRANSITION tool: it proves a
swap is safe. It is not the ceiling. This section sanctions deliberate
improvements — bug fixes, performance, quality — under one rule and a
gate matrix.

**The two-step rule.** A port lands bit-identical first; improvements are
separate, evidence-gated slices afterward. Never both in one change — a
regression inside a combined change is unattributable.

**Gate matrix** (every improvement slice declares its category up front):

| Category | Gates |
| --- | --- |
| Pure performance (no output change) | benchmarks beat the baseline; ALL parity suites unchanged |
| Output-changing, non-embedding | golden-fixture update reviewed WITH the change + written rationale; eval metrics where applicable |
| Embedding-changing | full re-embed; golden-eval no-regress PLUS stated improvement targets up front; new PINNED set; fixture regeneration; snapshot/schema coordination (template: RFC 0002 records, Stage-C compat cycle) |
| Schema/format-changing | compat cycle + derive/upgrade-path strategy (template: RFC 0002 records, Stage-C); determinism gates re-proven |
| Operational/architectural | smoke/ops evidence on the affected host class; rollback path stated |

Any improvement that adds a dependency or touches security posture
additionally routes through §2 and a §9 decision, regardless of category.

**The reference-flip rule.** At the FIRST deliberate divergence in a
domain, that domain's frozen-external-reference guards (e.g. the
transformers.js replay suites) convert to self-regression goldens: the
Swift implementation becomes its own reference, and fixtures regenerate
FROM it. The RFC 0002 records hold the embedder instance of this rule.

**Candidate registry** (one line + evidence pointer; execution requires a
planned slice):

- **(A) Embedding v2** — *embedding-changing* — **DONE 2026-06-12**:
  astral-CJK fix + i8 rounding (incidence zero); order/VS16 retained on
  evidence; the reference flip landed (Swift is its own reference;
  transformers.js = divergence recorder). Eval no-regress, mrr up;
  cos(`𠮷stack`,`stack`) −0.02 → 0.99. Record: [RFC 0002 records](0002-swift-embedder/records.md).
- **(B) SQLite query round-trips** — *pure-perf* — **DONE 2026-06-13**: a
  per-search `COUNT(*)` over the 358k-row body-FTS index was **43%** of
  search CPU; an existence probe (`hasBodyIndex`) + count memoization (+ a
  fuzzy N→1 batch) cut p50 **2.5–5×**, recall/ndcg/mrr byte-flat. Lesson:
  attribute self-time to the JS caller (`profile-cpuprofile.mjs --callers`).
- **(B′) Semantic Hamming-scan popcount** — *pure-perf* — **DONE 2026-06-13**:
  cpu-prof mis-attributed (claimed `insertSorted` 93.8%); direct timing
  showed the scan is ~99% popcount. A SWAR `Uint32` popcount
  (`embedding.js hammingU32`) + a max-heap took semantic search **55.8 →
  18.9 ms (3.0×)**, eval byte-flat (property-test-locked). Lesson: trust
  direct timing over sampler self-time. A hardware-POPCNT native scan stays
  a possible further slice.
- **(C) Burst-stall** — *operational* — **measured 2026-06-13: RESOLVED /
  non-reproducing, no code**: `/healthz` is structurally exempt (a sibling
  origin route before the `/mcp` semaphore — saturation-503 already gone);
  a 16-burst held healthz at 1 ms, 8/8 200 on arm64 (the mm18 stall was
  Intel + cold). Onset yield-points deferred pending affected-host
  evidence. Runbook: ops/runbooks/mcp-burst-healthz.md.
- **(D) Prerender batching** — folded into RFC 0003 phase 2 (**DONE**).
- **(E) Snapshot/storage size** — *schema/format* — **OPEN** (not yet
  attempted): the 2.47 GB asset-ceiling; raw-payload + compaction strategy.
- **(F) Chunking-parameter revisit** — *embedding-changing* — **EVAL SWEEP
  2026-06-13 → NO-GO** (`scripts/chunk-sweep.mjs`): a full 358k-doc re-embed
  per candidate + `eval-search`; no set robustly beats baseline (deltas
  ≤0.5%, inconsistent across fusion modes — `16/880/160` helps baseline-rrf
  Δmrr +0.0047 but regresses hybrid+mmr −0.0009; at +4.6–7.5% chunks).
  **Keep 8/880/160.** Harness retained for re-test.

---

*Maintenance*: update the inventory (§3) and decision log (§9) as phases
land; each phase's completion gets a dated entry here.

- **2026-06-11 — P0 research complete** ([`p0/`](0001-swift-native-transition/p0/README.md)):
  ABI contract v0 validated on macOS arm64 + Linux arm64; §4 products, §5
  toolchain, and the risk register corrected from experiments E0–E7;
  thirteen decisions logged (D-P0-1…13). P0 implementation not started.
- **2026-06-11 — platform doctrine recorded**: the project targets
  state-of-the-art performance/efficiency/accuracy on macOS AND Linux,
  permanently; a possible relocation of the public instance to a Linux
  cloud (Amazon/Oracle) is a **later-stage, RFC-triggering iteration** —
  it does not demote darwin serving today. (Context: embedder runtime
  choices in [RFC 0002 records](0002-swift-embedder/records.md).)
- **2026-06-11 — P0 implemented + P1 fusion shipped (default off)**: the
  `swift/` package landed with the common bases target (`ADBase` — result
  buffers, status enums, bounds-checked request reader, build info — the
  cross-platform layer every later module and the migrating renderer
  scripts build on), `ADSearch` fusion math, `ADCore` exports;
  `src/native/loader.js` + `src/search/fusion-native.js` behind
  `APPLE_DOCS_NATIVE`; CI `native` job on all three targets. Parity:
  `Object.is`-exact across fixtures + 400 seeded property cases.
- **2026-06-11 — P1 CLOSED (ranking/snippets stay JS for the bridge era,
  by measurement; they ride P6's orchestrator migration — the full-Swift
  end state is unchanged)**:
  `rerank` = 158.8 µs at the maximum realistic input (300 real-corpus
  rows incl. intent detection) — **0.04 %** of a natural-language lexical
  query (372 ms p50, full corpus) and ~2 % of the hot symbol-lookup floor
  (0.44 ms, ~10-row inputs). A port would be marshalling-bound (the fusion
  n=10 lesson) and must reproduce exact JS double semantics around the
  0.001-epsilon sort: all risk, no win. Snippets (38 LOC, post-slice
  string ops) and highlighting (static-build path) close with it. P1's
  shipped scope — fusion + archiver (now pax-complete) — is final.
- **2026-06-11 — P2 EXECUTED (embedder phases 1–5)**: `ADEmbed` model2vec
  inference native-by-default (`embed` token); 831k-chunk equivalence
  byte-identical; Stage-C kills executed (transformers/onnxruntime
  gated-only; snapshots ship the ADMX artifact instead of model.onnx).
  → [RFC 0002](0002-swift-embedder.md) + its records.
- **2026-06-12 — P2 COMPLETE + P4 main line**: embedding v2 + the reference
  flip (RFC 0002 — Swift is its own reference now); content
  markdown/plaintext native + default-on after the §10 perf round
  (`content` token, 2–3.2× batched, byte-proven at 358k-doc scale —
  RFC 0004). §10(A) embedding v2 + §10(B) SQLite query round-trips (43% of
  search CPU was a `COUNT(*)`; p50 2.5–5×, byte-flat).
- **2026-06-13 — P3-darwin + P4 close + §10 slices**: P3 phases 1/2/4 —
  font-text + symbol-pdf + symbol-png + the symbol prerender native, and
  the Linux HarfBuzz shaper that **dropped the hb-view host binary**
  ([RFC 0003](0003-swift-render-service.md)). P4 phases 3-4 **NO-GO** by the
  static-build profile (IO-bound, render ~6% — RFC 0004). §10: **(B′)**
  Hamming-scan popcount (search **3×**, byte-flat), **(C)** burst-stall
  resolved/non-reproducing, **(F)** chunking sweep NO-GO. The only P3
  remainder is phase 3 (darwin spawn-script kills), held on the §4
  release-cycle gate.
- **2026-06-13 — RFC docs reorg**: per-RFC `records.md` archives
  (0002/0003/0004) extending the `p0/` precedent; living RFCs condensed to
  status + contract + forward plan; this maintenance log completed;
  rfcs/README.md refreshed to a P0–P7 ladder. Audit (codebase vs docs)
  found **no drift**; no code changed.
- **2026-06-13 — P5 first slice (storage foundation + `searchPages`
  probe)**: `ADStorage` (runtime-dlopen'd libsqlite3, raw C interop — D4
  settled) + the `searchPages` read path behind the bridge. A/B byte-parity
  PASS (bm25 bit-identical), WAL coexistence PASS, concurrency **NO-GO**
  (native ~7-16% slower — FFI boundary tax over already-native bun:sqlite).
  `storage` ships **default-OFF**; the foundation is the P6 prerequisite (a
  SwiftNIO server can't call bun:sqlite). Detail:
  [p5/records.md](0001-swift-native-transition/p5/records.md).
- **2026-06-13 — P6 first slice (SwiftNIO host spike)**: standalone
  `ad-server` (first SwiftPM dep `apple/swift-nio`; Swift 6 + complete strict
  concurrency, TSan-clean) serving `/healthz` + `/search` over ADStorage
  in-process. **Host GO** (healthz 67k req/s ≥ Bun.serve, no event-loop
  stall, query parity-fine), but single-query `/search` **~2.5× slower** than
  the Bun worker pool — the per-request async-offload overhead rivals the
  ~0.3 ms query at this granularity. The inversion win needs the full cascade
  in-process (amortize one offload over all tiers); next slice ports it. Do
  NOT do a naive per-op port. Detail:
  [p6/records.md](0001-swift-native-transition/p6/records.md).
- **2026-06-13 — platform floor raised macOS 13 → 15.6** (operator decision):
  unlocks the `Synchronization` framework (`Mutex`/`Atomic`) + modern
  structured-concurrency APIs package-wide for the P6+ server, staying ≤ the
  macOS 26 production host. `ad-server`'s pool moved actor → `Mutex`; the
  accept loop uses `DiscardingTaskGroup`. Next-slice toolkit: swift-atomics /
  swift-collections / swift-async-algorithms (atomics/mutex/Deque over actors).
- **2026-06-13 — P6 second slice (lexical-cascade port)**: the JS lexical
  search (T1+T2, merge, intent, rerank, projection) ported byte-exact into a
  Swift `/search` (new server-only `ADSearchCascade`; ADStorage gained
  `SearchRow` + searchTitleExact/searchTrigram). **Byte-parity PASS** (10/10 —
  the projection strips floats → labels, so parity is ordering + fields, and
  rerank scores are bit-identical). **Perf NO-GO**: Swift full cascade ~3×
  SLOWER than Bun (ab). Made it **tier-parallel** (3 tiers via `async let`
  offloads) — STILL ~3×. A concurrency sweep localized it: Swift is comparable
  at c=1 (~2 ms cascade) but **throughput DEGRADES under concurrency** while
  Bun scales. Blamed the **SwiftNIO async serving model** — *but the third
  slice (below) DISPROVES that*; the serving model is fine. Detail:
  [p6/records.md](0001-swift-native-transition/p6/records.md).
- **2026-06-13 — P6 third slice (classic EL-handler + scaling localization)**:
  reverted the serving path to a classic EL-confined `ChannelInboundHandler`
  (`@unchecked`, one `EventLoopFuture` offload — no per-request `Task`/
  cooperative executor). It is **faster than Bun at c=1** (636 vs 574) but
  **still degrades** under concurrency — so the async machinery was NOT the
  cause. Four experiments relocated the bottleneck OFF the serving model: (1)
  ELG count 2–10 identical; (2) a 0-match query traverses the full
  offload/pool/EL path at **1082 req/s** @ c16 (healthz 78k) and throughput
  tracks the **FTS matchset size** → the cost is the per-request cascade WORK,
  not the host; (3) **negative thread scaling** (threads=4 → 514 > 8 → 392) =
  shared-resource contention; (4) `MallocNanoZone=0` did not help → not the
  nano allocator. SQLite `-shm` ruled out (Bun shares the same file from
  workers and scales). Residual = Swift's String/ARC-heavy decode+rerank+JSON
  being **less concurrency-efficient than Bun's per-isolate runtime** (needs
  Instruments to pin; `ab`-on-same-host is a measurement confound, but Bun
  under the same client scales). A serving-model head-to-head (identical
  sequential work) then found the classic `@unchecked` handler **no faster than
  the safe async model** (c=1..16 statistically identical, async marginally
  ahead) → the classic handler + `--serving` switch were removed; `ad-server`
  carries **no `@unchecked`** beyond the contained `StorageConnection`. Then a
  **stage-isolation probe** (operator chose "pin the cause first") swept three
  granularities of the same request — `/search-rawscan` (3 tier SQL, count
  only), `/search-decode` (+ String decode), `/search` (full): **all converge
  to ~390 req/s at c=16** (c=1: 845 / 733 / 608). This **exonerates the cascade
  code** — the decode/rerank/JSON costs only at c=1, NOT the c=16 ceiling, which
  is the **SQLite FTS scan + host topology** (8 thread-pool threads + 2 loops +
  the same-host `ab` on 10 cores; thread-sweep oversubscription signature). The
  Bun gap is apples-to-apples (Bun runs the same 3 unfiltered tiers). So the
  alloc/ARC-light rewrite is **off the table** (won't lift the ceiling); the
  residual is a SQLite-concurrency / thread-topology / same-host-measurement
  question a **clean load-generator host** would settle. Fork (open): clean-host
  re-measure vs search serving stays Bun (cascade + serving proven good, banked
  for P7). Detail: [p6/records.md](0001-swift-native-transition/p6/records.md).
