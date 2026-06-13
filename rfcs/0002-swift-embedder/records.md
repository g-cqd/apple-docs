# RFC 0002 — embedder execution records (archive)

Detailed decision + phase records for the Swift-native embedder, moved here
when [RFC 0002](../0002-swift-embedder.md) reached **COMPLETE** so the
living RFC stays concise. This is the audit trail — the dated bake-off, the
runtime matrix, the ship-vectors option, and the phase-1→5 + embedding-v2
execution records. Repo documentation; never built or indexed by the docs
site. Parent: [RFC 0001 §7 P2](../0001-swift-native-transition.md).

---

## Decision records

### D-0002-5 — the model bake-off

Recommendation source: external advice favored EmbeddingGemma-300M (MTEB
retrieval ~69.7 En v2, #1 under 500M params vs potion's static-model ~35–36
retrieval score). MTEB transfers imperfectly to this corpus (exact-symbol
heavy, English-only, 50 ms p95 search budget, CPU-only serving), so the call
is made on OUR eval: `scripts/eval-embed-bakeoff.mjs` — same pruned subset
corpus (~66k docs / ~187k chunks: swiftui/foundation/uikit/combine/swift +
all small sources), per-model child processes, lexical-only control row,
trap guards against the silent lexical-degradation failure mode, query
micro-bench over the curated judgments.

Ladder (smallest-first, per cost analysis): `potion-retrieval-32M`
(32M static) → `bge-small-en-v1.5` (33M transformer, 384-dim, CLS pooling —
the classic middle class the 32M→300M jump skipped) →
`embeddinggemma-300m-q8` (QAT int8 — the realistic CPU-serving dtype;
fp32 is a quality ceiling, measured separately only if needed).

Results recorded (subset, hybrid+mmr, k=10). The ladder was **terminated by
user decision** after the cost columns landed: every transformer rung costs
hours of consumer-side CPU per install, which was judged operationally
unacceptable regardless of the quality columns (left unmeasured by design —
the cost veto precedes them).

| model | dims | index wall | chunks/s | query p50/p95 | recall@10 | ndcg@10 | mrr | ndcg curated/anchor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| lexical-only (control) | — | — | — | — | 0.6790 | 0.5783 | 0.5490 | — |
| potion-retrieval-32M | 512 | **0.3 min** | 9,801 | **0.1 / 0.2 ms** | 0.6914 | 0.5791 | 0.5463 | 0.2801 / 0.6031 |
| bge-small-en-v1.5 | 384 | aborted at 75% (~2 h projected) | ~27 | *(unmeasured)* | — | — | — | — |
| embeddinggemma-300m-q8 | 768 | never started (~3–4 h projected) | — | — | — | — | — | — |
| embeddinggemma-300m (fp32, ceiling) | 768 | aborted (≈9.5 h projected) | 5.2 | — | — | — | — | — |

Readings:
- **Cost wall**: 18 s (static) vs ~2 h (33M transformer) vs ~9.5 h (300M
  fp32) for the same ~187k-chunk subset — a 400–1,900× spread. Per-consumer
  re-embedding (today's setup architecture) only tolerates the static class.
- Potion's semantic lift is real but concentrated: overall hybrid+mmr ≈
  lexical (ndcg +0.0008) with the value in curated NL queries and a small
  MRR cost — improving the *retrieval pipeline* (chunking, rescore, fusion
  weights) likely pays more than swapping models at consumer prices.
- Any future quality re-match happens **only behind ship-vectors** (build-
  host embeds once); the committed harness (`scripts/eval-embed-bakeoff.mjs`)
  and the bge/gemma-q8 registry rungs remain in place for that day.

### D-0002-6 — runtime matrix (doctrine: SOTA on macOS AND Linux)

The production platform doctrine (recorded user decision, 2026-06-11): the
project runs state-of-the-art performance/efficiency/accuracy on BOTH
macOS and Linux; a cloud relocation of the public instance is a
later-stage, RFC-triggering iteration — no platform is demoted now.

| Runtime | Fit | Notes |
| --- | --- | --- |
| **From-scratch Swift** (this RFC's core) | static models (potion class) only | Runtime-free, Linux-perfect, µs-class; cannot run transformers |
| **Vendored ggml/llama.cpp** | transformer models, CPU both OSes | Official ggml-org EmbeddingGemma GGUFs (incl. QAT + dense modules); dependency-policy exception required (vendored C, BSD-class); **verification gate: open llama.cpp embedding-accuracy issue #19040** (Jan 2026, divergence vs transformers reference) must be re-checked on our parity fixtures before adoption |
| **onnxruntime C API via dlopen** | transformer models, CPU both OSes | The middle path: kills the napi/npm packaging mess (incl. the darwin-x64 gap) while keeping ORT's kernels; same dlopen discipline as the libzstd binding |
| **MLX / mlx-swift** | darwin (Metal); Linux only via CUDA (NVIDIA) | Not a CPU-serving answer; mlx-swift CUDA support is a proposal. Position: optional **build-host accelerator** (snapshot builds run on Apple-Silicon CI) — pairs with ship-vectors. Claimed constant-RSS under concurrent users (second-hand, unverified here) |

### Ship-vectors option (orthogonal, either model)

Precomputed chunk vectors as a **separate release asset**
(`apple-docs-vectors-<tag>.tar.zst`): int8+binary for ~860k chunks ≈
0.7 GB — under GitHub's 2 GiB per-asset ceiling that forced "snapshots ship
no vectors". Kills the consumer-side re-embed entirely (today's setup
rebuild = minutes for potion, hours for any transformer — which makes this
option near-mandatory if D-0002-5 picks a transformer). Embedding then
happens once, on the build host, where Metal/MLX acceleration is available.
Licensing flag: shipping Gemma-derived *vectors* is model output (fine);
shipping Gemma *weights* in snapshots or pinning them in
`PINNED_MODEL_FILES` triggers Gemma Terms-of-Use obligations (notice +
restrictions) — record before any such change.

---

## Phase records

Phase ladder (all done 2026-06-11 unless noted):

1. **Spike — tokenizer parity** (no FFI): `ADEmbed` library target + Swift
   Testing gate; 180 fixture cases, 100% token-id equality on the first
   full run. Settles D-0002-3. §record-1.
2. **Matrix + pooling**: ADMX weights artifact + mmap reader + mean-pool;
   bit-exact vectors AND byte-exact sign/int8 codes on 180 cases (CI) +
   2,000 corpus chunks. §record-2.
3. **FFI + dispatch**: `ad_embed_batch`, `embedder-native.js`, kill switch;
   2.68× throughput, p50 0.021 ms, init 54 ms, matrix mmap'd. §record-3.
4. **Quantizers + retrieval gates**: native sign/int8 codes; 831,216-chunk
   equivalence (byte-identical), golden-eval identical, 2.09× full re-embed.
   §record-4.
5. **Default flip + kills**: native-by-default flip (2026-06-11); Stage-C
   kills EXECUTED (transformers/onnxruntime demoted to gated-only, snapshots
   ship ADMX). §record-5 + Stage-C.
6. **Embedding v2** (2026-06-12): the first deliberate divergence + the
   reference flip. §record-6 (embedding v2).

### Record 1 — tokenizer parity (done 2026-06-11)

Deliverables: `swift/Sources/ADEmbed/` (Foundation-free: `Tokenizer`,
`Normalizer`, `CaseFolding`, `NFD`, `PreTokenizer`, `WordPiece`, byte-keyed
`Vocab`, `GeneratedUnicodeTables`), `swift/Tests/ADEmbedTests/` (stage units
+ the parity gate), `scripts/gen-unicode-tables.mjs`,
`scripts/gen-tokenizer-fixtures.mjs`, committed fixtures under
`test/fixtures/tokenizer-parity/` (~2.3 MB: sha-pinned
tokenizer{,_config}.json copies, id-ordered vocab.json, 180-case
cases.json), and the drift alarm `test/unit/search/tokenizer-fixtures.test.js`.

**The parity target is the installed transformers.js (4.2.0), not the HF
Rust reference.** Divergences the Swift mirror reproduces deliberately:

- normalizer order is lowercase → strip_accents (Rust strips first);
- `tokenize_chinese_chars` iterates UTF-16 units, so astral CJK
  (U+20000+) is never spaced — the astral ranges in its source are dead
  code; the generated table is BMP-only on purpose;
- clean_text removes Cc/Cf/Co outright (VT, FF, FEFF, ZWSP, SHY, ZWJ —
  no space survives); only `\t` `\n` `\r` reach the whitespace→' ' branch;
- strip_accents = NFD + full `\p{Mn}` removal (variation selectors strip);
- JS toLowerCase applies Final_Sigma ("ΟΔΟΣ"→"οδος"); Swift `lowercased()`
  does not → per-scalar `lowercaseMapping` plus an explicit Final_Sigma
  context rule (stdlib Cased/Case_Ignorable).

Swift-side traps closed: `Dictionary<String,_>` conflates canonically
equivalent keys while JS Maps key on exact code units — and the vocab
carries 18 NFD-form Korean entries — so `Vocab` keys on UTF-8 bytes; Swift
6.3 exposes no public NFD API, so canonical decompositions are
table-driven (Hangul algorithmic).

**Skew elimination**: every character-class decision (Mn, Bert punctuation,
JS `\s`, control-removal set, NFD decompositions, chinese ranges) is
generated from the same JavaScriptCore engine that produces the fixtures;
the Swift stdlib contributes only canonical combining classes (reordering)
and the Final_Sigma properties, both fixture-covered.

**Regeneration protocol**: a transformers.js bump that changes tokenization
fails `tokenizer-fixtures.test.js` (version stamp + full 180-case replay)
→ rerun both generators, commit the diff, and the Swift gate must re-pass
at 100%. (INVERTED at embedding v2 — the Swift implementation is the
reference now; transformers replays as the divergence recorder.)

### Record 2 — matrix + pooling (done 2026-06-11)

Deliverables: `swift/Sources/ADEmbed/{MatrixArtifact,Pooling,Quantize,
Embedder}.swift` (Foundation-free; mmap via raw Darwin/Glibc syscalls),
`scripts/gen-embed-matrix.mjs` (protobuf walk + ADMX v1 export, full +
sparse-subset modes), `scripts/gen-embed-fixtures.mjs`, committed
`test/fixtures/embed-parity/` (~7.6 MB), the drift alarm
`test/unit/search/embed-parity-fixtures.test.js`, and the Swift gates in
`ADEmbedTests`.

**The graph finding that shaped the phase**: potion's model.onnx is NOT a
plain EmbeddingBag — probing single-token bags against raw initializer rows
proved the output is **f32-sequential mean → f32 L2-normalize**, bit-exact
across bag sizes (f64 accumulation drifts ~1.5e-8). Consequences: raw row
magnitudes are unrecoverable from inference → initializer extraction is
mandatory (D-0002-1); outputs are unit-norm → the JS path adds no
normalization and both quantizers are scale-invariant; bit-exactness became
attainable → §3's parity/acceleration contracts were amended (bit-equality
is the contract; portable kernel only, vDSP deferred).

Corpus fixtures: chunk text is not stored in the DB (`text: null`), so the
2,000 chunks are re-derived through the indexer's own path (lowest document
ids → `getSectionsByDocumentIds` → `chunkDocument`, (docId, ord) order) and
committed with their vectors — provenance-stamped (transformers 4.2.0 +
onnxruntime-node 1.24.3 + model sha). Gate split: CI native matrix runs the
180-case gate against the sparse subset (no model); the 2,000-chunk gate
runs wherever `matrix-v1.admx` exists via `.enabled(if:)`.

### Record 3 — FFI + dispatch (done 2026-06-11)

Deliverables: `swift/Sources/ADCore/EmbedExports.swift`
(`ad_embed_init`/`ad_embed_batch`/`ad_embed_reset`; ADCore now depends on
ADEmbed), `src/search/embedder-native.js` (never-throws builder,
announce-once, scratch batch packer), the `getEmbedder` insertion (default
model only, outside the try so a dispatch bug can't kill the transformers
fallback), `src/lib/admx.js`, the JS↔FFI↔Swift round-trip test, and
`test/benchmarks/embed-bench.js`.

Decisions recorded:
- **State model**: one process-wide embedder behind a pthread mutex;
  re-init is idempotent-ignore; `ad_embed_reset` is a test seam. In-flight
  batches survive a reset (own matrix reference; munmap on last release).
- **On-demand weights artifact**: consumers derive `matrix-v1.admx` once
  from the snapshot-shipped pinned model.onnx (full `verifyPinnedModelFiles`
  first, temp+rename atomic). Snapshots do not grow.
- **No per-call JS fallback**: after a native embedder is built, embed
  errors THROW. The whole-embedder choice happened at build time; the query
  path catches → lexical, `index embeddings` rolls back its batch + stays
  resumable.
- **Throughput**: the 1.42× first probe was lifted to 2.68× by removing
  per-candidate allocations from the WordPiece greedy loop (flat-arena
  FNV-1a vocab probe), gating `lowercaseMapping` behind
  `changesWhenLowercased`, and ASCII bails before NFD/ccc/Mn lookups — all
  under the bit-exact gates.

Measured (arm64 M-series, release, 2k corpus): native 26,636 chunks/s vs
transformers.js 9,929 (2.68×); single p50 0.021 ms / p95 0.089 ms; init
54 ms; process RSS 193 MB with the 129 MB matrix mapped.

### Record 4 — codes + retrieval equivalence (done 2026-06-11)

Deliverables: `ad_embed_batch_codes` (count × 580 B sign+int8 blobs — the
exact storage shapes, so the index path crosses 580 B/chunk instead of the
2 KB f32 vector plus a JS quantize pass), `embedBatchCodes`/`dims` on the
native embedder, the index-pipeline capability branch
(`src/commands/index-embeddings.js`), `pregenerateMatrixArtifact` in `setup
--native`, and `scripts/verify-embed-equivalence.mjs`.

**Setup ordering fix**: `installNativeBundle` previously ran AFTER the
semantic index build — a fresh install embedded via JS even with the kill
switch on. The bundle now lands first; the artifact pre-generates after
extraction (warn-only).

**The equivalence gate** (full live corpus): 831,216 chunks — **0 blob
mismatches, 0 unmatched rows, 0 anchor mismatches**, embed_dims equal — the
native-built index is byte-identical to the JS-built index, hence
retrieval-identical forever. Golden eval on both legs: all quality metrics
identical to the last digit. End-to-end `index embeddings --full` over 831k
chunks: **2.09× faster** native (47 s vs 93–98 s). Codes throughput 24,820
chunks/s (**2.49×**); RSS-attributable ≈ 151 MB against the §3 ceiling of
161 MB → memory gate met.

### Record 5 — native-by-default (flip shipped 2026-06-11; kills gated)

**Flip semantics** (`src/native/loader.js`): unset/''/'1'/'on' → every
migrated module serves natively wherever the dylib + artifacts exist, JS
serves bit-identically otherwise; '0'/'off' → JS everywhere (the documented
escape hatch); csv → exactly those modules. The full test suite passed
default-on with ZERO pinning needed.

**Release machinery**: stable snapshot builds pin `APPLE_DOCS_NATIVE: embed`
at the job level (transitional one cycle); ADMX excluded from snapshot
archives this cycle (the kill-step decides shipping it); scripts that
encoded "unset = off" were flipped in the same commit.

**Soak — LIVE 2026-06-11** (`ops/runbooks/native-embed-soak.md`):
snapshot-20260611-beta.3 deployed to mm18; the Intel host derived
`matrix-v1.admx` itself, services healthy, `embed`/`fusion: served by
native`. Intel: native codes 12,898 chunks/s, p50 0.040 ms, init ~112 ms,
RSS ≈ 122 MB. Baselines: transformers.js 3,966/s (native ort) and 3,953/s
(WASM) — **indistinguishable, because the baseline bottleneck is the JS
tokenizer, not ort inference**, which corrects the original ≥5×-vs-WASM
premise; the honest Intel number is 3.3–3.5× end-to-end.

### Stage-C — the kills (EXECUTED 2026-06-11)

**Entry criteria disposition:** the operator compressed the gate by manually
dispatching the stable release (snapshot.yml run 27372218651 from
pre-Stage-C main) — that release is the LAST onnx-bearing snapshot, so
consumers receive one full compat cycle before the first ADMX-only snapshot.
mm18 soak was clean; no escape-hatch reports.

**Execution (commits 640ff86 / 0f200d9 / 994035b):**

1. **Snapshots ship ADMX instead of model.onnx (−124 MB).** The snapshot
   build runs `ensureMatrixArtifact` and INCLUDES `matrix-v1.admx(.sha256)`
   while EXCLUDING `onnx/`. `PINNED_MODEL_FILES` becomes {tokenizer.json,
   tokenizer_config.json, matrix-v1.admx} (admx pin stable — deterministic
   bytes). `ensureEmbeddingModel` probes via the native embedder; the
   release-build hard-fail keys on the native embedder. Compat (one cycle):
   the derive-from-onnx path stays for older snapshots, retires after.
2. **transformers.js / onnxruntime demotion (D-0002-4 caveat).**
   `getEmbedder`'s default-model path becomes native-or-null (lexical
   degradation) — the buildModel2Vec transformers branch + the WASM fallback
   are deleted FOR THE DEFAULT PATH. `@huggingface/transformers` +
   `onnxruntime-*` remain optionalDeps used ONLY by the gated
   feature-extraction registry entries (gemma/bge…). The model acquisition
   moved into `model-integrity.js` (pin-verified direct HF fetches);
   `LEGACY_ONNX_SHA256` survives as the immutable derivation-source pin.
3. **Cleanups**: docs drop the "derived from model.onnx" language; the 831k
   equivalence script retired (purpose fulfilled); the committed fixtures are
   the frozen transformers reference and the replay guard is
   native-vs-fixtures.

### Record 6 — embedding v2, the first deliberate divergence (EXECUTED 2026-06-12)

§10 candidate (A), category **Embedding-changing**. Operator scope: full
un-copy; each registered review closed on evidence:

| Review | Outcome | Evidence |
| --- | --- | --- |
| UTF-16 chinese-chars (astral CJK never spaced) | **FIXED** — BMP mask dropped; chineseChar table 3 → 6 ranges (28,096 → 81,520 scalars) | vocab has ZERO astral tokens, so the win is **neighbor recovery**: v1 glued `see𠮷docs` into one whole-word UNK; v2 yields `see` + UNK + `docs` |
| ECMA Math.round mirror (i8 halves toward +∞) | **CHANGED** to half-away-from-zero (`Quantize.swift` + `embedding.js` lockstep) | measured incidence ZERO across every non-divergent case + the 2,000-chunk corpus — observably free |
| lowercase→strip order (Rust strips first) | **RETAINED** | exhaustive commute scan (1.1M scalars × 8 sigma/mark templates + 874 cased bases × 2,059 Mn marks) found **zero** differing inputs — the swap is pure churn |
| VS16/Mn stripping | **RETAINED** | NFD + full Mn removal is shared HF-Rust semantics, matches training-time tokenization |

**Reference flip executed.** `gen-tokenizer-fixtures.mjs` records ids from
the Swift tokenizer (new `ad-embed-dump` executable target; dev-only, not in
the dylib); transformers.js 4.2.0 stays as the **divergence recorder** —
validated against a hand-written `EXPECTED_DIVERGENT_CASES`
(anti-self-licensing). `tokenizer-fixtures.test.js` asserts equality for
non-divergent cases and INEQUALITY for divergent ones. Corpus: 189 cases;
subset ADMX 608 → 613 rows. Divergences (7): `cjk-astral`,
`cjk-astral-latin-glue`, `cjk-astral-run`, `cjk-astral-compat`,
`judgment-37/38/39`. Fixture-diff: among the prior 180 cases exactly ONE
(`cjk-astral`) changed; corpus vectors 0/2000 differ.

**Version machinery.** `EmbedBehavior.version = 2`; `ad_embed_init` payload
is `[u32 dims][u32 rows][u32 behaviorVersion]` (8-byte legacy = v1).
`index embeddings` stamps `snapshot_meta.embed_version` and force-fulls on
mismatch — verified live: `stored v1 → live v2 — full re-embed`, 831,216
chunks in 61 s. `snapshot build` strips `embed_version`; every install
self-converts; artifact pins UNCHANGED.

**Eval gate** (168 judgments = 150 anchors + 18 curated, incl. 6 new
CJK/emoji/astral rows): lexical-only identical; every semantic config
recall/ndcg unchanged with mrr strictly up (baseline-rrf 0.6586 → 0.6591,
hybrid 0.6538 → 0.6543, hybrid+mmr 0.6414 → 0.6419). Tier-level recovery:
cos(`𠮷stack`, `stack`) = −0.0247 (v1) → **0.9895** (v2). Perf: v1 dylib
22,380 f32 / 20,333 codes vs v2 22,940 / 21,788 chunks/s (v2 ≥ v1); p50
0.020 ms, init ~60 ms.

**Rollout (same day).** `snapshot-20260612-beta.1` published (1.87 GB) and
mm18 deployed: setup re-embedded the full corpus with the v2 bundle, smoke
16/16. Intel: 13,103 codes/s (v1 12,898), p50 0.040 ms — slight win.

Adjacent observations (out of scope, recorded for later): 31/43 curated
judgments never resolved against live corpora (`documentation/`-prefixed
vs unprefixed live keys); the fuzzy-title FTS path logs a safeCall'd
`unterminated string` on astral-bearing queries.

---

## Risks (all retired)

| Risk | Mitigation / outcome |
| --- | --- |
| Tokenizer mismatch long-tail | Phase-1 gated 100% token-id equality before any math — held on the first full run |
| Float-sum drift beyond 1e-5 under SIMD reordering | bit-equality became the contract (portable kernel; Swift never reassociates) |
| mmap on the data dir vs security policy | weights are DATA (read-only mmap, no PROT_EXEC) — fine |
| Setup regression if native absent | dispatch defaults to JS; setup uses native only when enabled |
| Intel macs (least CI coverage) | darwin-universal artifact + mm18 as the soak target |
