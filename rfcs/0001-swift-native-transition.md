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

### P0 — Toolchain, CI, FFI skeleton
`swift/` package + `Sources/ADCore` with a trivial exported function
(`ad_abi_version()`); bun:ffi loader shim with the kill switch + impl
logging; CI matrix (build, test, artifact upload); parity-test rig (A/B
runner + benchmark wiring). *Gates*: artifacts load on all three platform
targets; `bun run ci` green with the shim present-but-unused.
**Research complete (2026-06-11)** — ABI contract v0, loader design, CI
design, security model, and measured boundary costs live in
[`p0/`](0001-swift-native-transition/p0/README.md).
**Implemented (2026-06-11)** — `swift/` package (ADBase common bases +
ADSearch + ADCore → `libAppleDocsCore`), `src/native/loader.js` +
`APPLE_DOCS_NATIVE`/`APPLE_DOCS_NATIVE_LIB`, and the `native` CI job
(macos-26 / ubuntu-latest / ubuntu-24.04-arm: build, swift test, staged
$ORIGIN bundle, JS↔Swift parity). All P0 gates met; release-asset
attachment stays deferred until a module defaults to native.

### P1 — Leaf hot functions (pure compute)
Ranking/fusion math (`search/ranking.js`, `fuse-semantic.js` — weightedRRF,
MMR, score shaping), snippet extraction, and the tar.zst archive writer
(system `zstd`, preserving byte determinism). All pure functions with exact
JS reference outputs. *Kills*: nothing yet (prep). *Gates*: bit-identical
outputs on recorded fixtures; search benchmark p50 not worse; snapshot
determinism gate green with the native archiver.
**Partial (2026-06-11)** — fusion shipped behind the kill switch:
`ADSearch` mirrors `fusion.js` with `Object.is`-exact parity (400 seeded
property cases + fixtures, Map order identical), `fuse-semantic.js`
dispatches through `src/search/fusion-native.js`. Measured (arm64 Mac):
MMR 1.4–1.8× faster native; hybridFusion +8 % at n=100, slower at n=10
(packing dominates tiny payloads — the p0 batching rule, observed).
Default stays JS. Content hashing is **dropped from P1**: `sha256` already
runs on Bun's native CryptoHasher; nothing to win.
**Archiver shipped (2026-06-11)** — `ADArchive` streams synthesized-ustar
tar.zst through a runtime-dlopen'd libzstd (no tar/zstd host binaries, no
multi-GB temp tar) behind `APPLE_DOCS_NATIVE=archive`; parity gates are
extraction-equality + rebuild-twice (bsdtar byte-equality is impossible by
construction). Pax extended headers added 2026-06-11 after a production
fallback (a 103-byte SF Symbols FILENAME no 155+100 split can represent) —
the writer now covers every production path (273k-file tree verified).
**P1 CLOSED (2026-06-11)** — ranking and snippets stay JS **for the bridge
era** by measurement (NOT a transition exemption — they migrate with P6's
search-orchestrator move, where they live inside the Swift process and the
FFI boundary tax that disqualifies them here does not exist):
`rerank` costs 158.8 µs at the maximum realistic input (300 results, real
corpus rows, intent included) = **0.04 %** of a natural-language lexical
query (p50 372 ms on the full corpus) and ~2 % of even the hot-cache
symbol-lookup floor (0.44 ms, ~10-row inputs where rerank is single-digit
µs). An FFI port would be marshalling-bound (string-heavy inputs; the
fusion n=10 lesson) and would have to reproduce exact JS double semantics
around the 0.001-epsilon sort — all risk, no measurable win. Snippets
(38 LOC of integer/string ops on ≤100 post-slice rows) and highlighting
(static-build path, not query-time) close with it. See §9.

### P2 — Embedder from scratch (the flagship)
> **Superseded by [RFC 0002](0002-swift-embedder.md)** (2026-06-11), which
> is the P2 contract: hard performance/memory/acceleration gates, the
> weights-artifact and tokenizer decisions, and `ADEmbed`
> internal-subpackage-first packaging. The sketch below is historical.
>
> Phase 1 (tokenizer parity) done 2026-06-11: `ADEmbed` WordPiece pipeline,
> 100% token-id equality with transformers.js on 180 committed fixtures
> (RFC 0002 §6a).
>
> Phase 2 (matrix + pooling) done 2026-06-11: ADMX weights artifact + mmap
> reader + bit-exact mean/normalize/quantize — vectors AND codes reproduce
> the JS/onnx reference bit-for-bit on 180 cases + 2,000 corpus chunks
> (RFC 0002 §6b).
>
> Phase 3 (FFI + dispatch) done 2026-06-11: `ad_embed_*` exports +
> `embedder-native.js` behind `APPLE_DOCS_NATIVE=embed`; gates met at
> 2.68× index throughput / 0.021 ms p50 (RFC 0002 §6c).
>
> Phase 4 (codes + retrieval equivalence) done 2026-06-11: native sign/int8
> codes over the bridge, setup ordering fixed, and the full-corpus
> equivalence gate — 831k chunks byte-identical, golden-eval metrics
> identical (RFC 0002 §6d).
>
> Phase 5 flip shipped 2026-06-11: `APPLE_DOCS_NATIVE` defaults ON for
> fusion/archive/embed (`off` = escape hatch); stable snapshot builds go
> native (embed-pinned one cycle); kills gated on the soak (RFC 0002 §6e).

model2vec inference in Swift: tokenizer (the model's tokenizer.json,
unigram/WordPiece — implemented with swift-parsing), embedding-matrix
mmap (safetensors reader), mean-pool + SIMD dot products; batch API for
index builds. *Kills*: `@huggingface/transformers`, `onnxruntime-node`,
`onnxruntime-web`, the Bun WASM fallback plugin, and the platform-binding
matrix that broke darwin-x64. *Gates*: vectors within 1e-5 of the JS/ONNX
reference on the full eval set; NDCG/MRR unchanged; index build ≥ 2× faster
than transformers.js (expected: far more).

### P3 — Renderers (consolidate the existing Swift)
> **Carried by [RFC 0003](0003-swift-render-service.md)** (2026-06-11):
> inventory, hard criteria, D-0003-1..4 (private-framework codepoint
> worker, dlopen shaper binding, AppKit thread model, payload transport),
> and the phased plan. The sketch below is historical.
>
> **Reordered 2026-06-12 (rfcs/README.md)**: P3 runs **darwin-first as a
> SIDE slice** in parallel with P4; the Linux shaper (and with it the
> hb-view kill, which requires it) is DEFERRED — hb-view keeps serving
> Linux until the deferred phase's revisit triggers fire.

The five inline Swift scripts (725 LOC: symbol worker, symbol-pdf,
symbol-png, font-text, codepoint worker) move into the package as a
persistent actor-based render service (one process, request/response over
the FFI boundary or a socketpair — no more JIT `swift script.swift` spawns,
which cost ~300ms each). Adds the **cross-platform text shaper** on
HarfBuzz/FreeType for Linux, replacing the hb-view host-binary dependency
introduced by the parity work; darwin keeps CoreText. *Kills*: swift JIT
spawn latency; the `hb-view` host package requirement. *Gates*: SVG
fixture diffs clean on both OSes; render service p50 < the spawn path.

### P4 — Content pipeline
> **Carried by [RFC 0004](0004-content-pipeline.md)**. Phases 1-2 + the
> §6b perf round EXECUTED (2026-06-12): markdown/plaintext renderers
> native + default-on (tape parser, parallel batches; byte-proven at
> 358k-doc scale). **Phases 3-4 closed by measurement (2026-06-13,
> §6c/D-0004-8): NO-GO** — the static build is 84% filesystem IO + 6.5%
> SQLite; the render surfaces phase 4 would port are ~6% (mostly shiki
> WASM), so a port can't move build wall-time. The sketch below is
> historical (swift-markdown/cmark NOT adopted, D-0004-4; shiki not the
> bottleneck). **P4's live work is done; the main line advances** (see
> rfcs/README.md). Phase 3 (crawl-time normalize) remains a separate,
> independently-gated question.

DocC JSON → Markdown/HTML on swift-markdown/swift-cmark; syntax
highlighting replaces shiki — swift-syntax for Swift code; a research
spike picks the approach for other languages (in-house TextMate-grammar
engine vs tree-sitter [system lib, would need a §9 exception] vs reduced
language set). *Kills*: `shiki`. *Gates*: rendered-page fixture corpus
diffs (the 353k-page static build is its own gate: byte-diff a sampled
build), web-build benchmark ≥ JS.

### P5 — Storage
SQLite C-interop module (prepared-statement cache, typed row decoding —
possibly pointfreeco's swift-structured-queries for the query layer);
reader pool becomes actors on the native side, replacing the
worker_threads pool at the FFI boundary. *Kills*: `bun:sqlite` (via the
facade — its 13 call sites in `database.js` are the entire surface),
`Worker` reader-pool. *Gates*: full unit suite A/B green; search-real
concurrency benchmark ≥ JS; WAL/locking behavior verified under the
container contention test.

### P6 — Servers (fully custom, in-house on SwiftNIO)
> **D1 settled 2026-06-12 (operator decision)**: no Vapor — the spike is
> cancelled. The web + MCP HTTP layer is built from scratch directly on
> SwiftNIO (+ swift-http-types/swift-nio-ssl as needed), keeping the
> dependency universe at apple/* + swiftlang/* + pointfreeco/* only.

Implementation: web server (routes are already per-file handlers — port
them 1:1; benchmark throughput/latency on our recorded burst loads vs
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
| D2 | Highlighting engine for non-Swift languages (TextMate in-house vs tree-sitter exception vs reduced set) | **Open — P4 spike** |
| D3 | Windows timing | Deferred until after P7 |
| D4 | swift-structured-queries (pointfreeco) for the storage query layer vs raw C interop | Open — decide in P5 design |
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
| Embedding-changing | full re-embed; golden-eval no-regress PLUS stated improvement targets up front; new PINNED set; fixture regeneration; snapshot/schema coordination (template: RFC 0002 §6f's compat cycle) |
| Schema/format-changing | compat cycle + derive/upgrade-path strategy (template: RFC 0002 §6f); determinism gates re-proven |
| Operational/architectural | smoke/ops evidence on the affected host class; rollback path stated |

Any improvement that adds a dependency or touches security posture
additionally routes through §2 and a §9 decision, regardless of category.

**The reference-flip rule.** At the FIRST deliberate divergence in a
domain, that domain's frozen-external-reference guards (e.g. the
transformers.js replay suites) convert to self-regression goldens: the
Swift implementation becomes its own reference, and fixtures regenerate
FROM it. RFC 0002 §6g records the embedder instance of this rule.

**Candidate registry** (one line + evidence pointer; execution requires a
planned slice):

- **(A) Embedding v2 — EXECUTED 2026-06-12 (record: RFC 0002 §6h)**:
  astral-CJK spacing fixed; i8 rounding changed to half-away-from-zero
  (measured incidence zero); lowercase→strip order and VS16/Mn stripping
  RETAINED on evidence (exhaustive commute scan / shared-Rust
  semantics). The reference flip landed with it — fixtures regenerate
  from the Swift implementation, transformers.js survives as the
  divergence recorder — plus `embed_version` stamping with
  mismatch-forced re-embed. Eval: no-regress, mrr strictly up;
  cos(`𠮷stack`, `stack`) −0.02 → 0.99.
- **(B) SQLite query-layer round-trips — EXECUTED 2026-06-13**: a caller
  attribution of the ~99%-in-`Statement.all/get` profile found the cost
  was NOT the hypothesized snippet/fuzzy round-trips (~1% combined) but
  three per-search AVAILABILITY checks each running `COUNT(*)` over a
  large table — `getBodyIndexCount` (`COUNT(*)` on the 358k-row body-FTS5
  index, ~130 ms warm) alone was **43%** of search CPU. Fix (output-
  identical): `hasBodyIndex()` existence probe (`SELECT 1 … LIMIT 1`) for
  the boolean-only body check; memoize the vector/chunk counts (value
  preserved, busted on re-embed); plus the fuzzy N→1 batch
  (`getSearchRecordsByIds`). Result, recall/ndcg/mrr **byte-flat** across
  168 judgments × 4 configs, p50 **276→53 ms (5.2×, lexical)** /
  **487→115 ms (4.2×, rrf)** / **261→106 ms (2.5×, hybrid)**. The
  measure-first discipline is the lesson: the profile's leaf (`Statement`)
  hid the real culprit until self-time was attributed to its JS caller.
  Remaining cost is legitimate cascade-FTS + the semantic Hamming scan
  (`semantic.js:213 insertSorted`, ~14%) — a separate future lever.
  Tooling: `scripts/profile-cpuprofile.mjs` gained native-frame caller
  attribution.
- **(C) Burst-stall architecture**: ~3 s event-loop stall at burst onset
  + healthz sharing waiting-room 503s
  (ops/runbooks/mcp-burst-healthz.md) — yield points, queue shaping,
  liveness exemption. Gates: smoke burst healthz clean, no throughput
  loss.
- **(D) Prerender batching**: folds into RFC 0003 phase 2.
- **(E) Snapshot/storage size**: the 2.47 GB asset-ceiling scare;
  raw-payload and compaction strategy.
- **(F) Chunking-parameter revisit** (src/search/chunker.js:59 —
  maxChunks 8 / windowChars 880 / overlapChars 160): SEPARATE eval unit
  from (A); may ride (A)'s re-embed transport only if its independent
  eval passes first — boundary moves change the corpus shape, and a
  bundled regression is unattributable.

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
  choices in [RFC 0002 §5b](0002-swift-embedder.md).)
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
