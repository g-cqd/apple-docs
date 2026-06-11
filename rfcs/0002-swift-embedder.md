# RFC 0002 — Swift-native embedder (model2vec inference in ADEmbed)

- Status: **Draft** (research; implementation not started)
- Parent: [RFC 0001 §7 P2](0001-swift-native-transition.md) — this document
  supersedes that section's sketch and is the P2 contract.
- Repo-internal: like all of `rfcs/`, never built or indexed by the docs site.

## 1. Why this is the flagship

The embedder is the only module whose JS implementation drags a dependency
subtree we cannot fix: `@huggingface/transformers` (optional) pulling
`onnxruntime-node`/`onnxruntime-web`. Costs today, all verified in-repo:

- **Platform-binding matrix**: onnxruntime ships no darwin-x64 napi binding —
  the standalone Intel-macOS binary cannot be compiled at all
  (`.github/workflows/snapshot.yml`, build-binaries comment), and Intel hosts
  run a single-threaded WASM fallback via a Bun loader plugin
  (`src/search/embedder.js`).
- **Supply-chain surface**: the heaviest third-party code in the tree, used
  for what is arithmetically a lookup table (see §2).
- **Setup latency**: snapshots ship no vectors (GitHub 2 GiB asset ceiling);
  every install re-embeds ~858k chunks locally — embedding throughput is the
  dominant term in `apple-docs setup`'s "a few minutes".

*Kills on completion*: `@huggingface/transformers`, `onnxruntime-node`,
`onnxruntime-web`, the WASM fallback plugin, and the darwin-x64 gap.

## 2. What the current pipeline actually computes (normative reference)

Model: `minishlab/potion-retrieval-32M` (model2vec, static). Per
`src/search/embedder.js` (buildModel2Vec):

1. **Tokenize** text with the model's `tokenizer.json`
   (`AutoTokenizer`, `add_special_tokens: false`); empty input pads to `[0]`.
2. **EmbeddingBag**: token ids + per-sample offsets → row lookups in the
   embedding matrix → **mean pool** per sample. No transformer forward pass —
   the "model" is one `[vocab × 512]` f32 matrix (the pinned `onnx/model.onnx`
   is an EmbeddingBag graph wrapping that matrix).
3. Output: 512-dim `Float32Array` per sample (`embed`/`embedBatch`,
   index-time batches of 64 documents with all chunks flattened into one
   call — `src/search/index-embeddings.js`).

Downstream quantization stays in JS for now (`src/search/embedding.js`):
sign-bit binary codes (64 B) + int8-with-f32-scale rescore codes
(`dims + 4` B), stored per chunk in `document_chunks` (v25). Query-time:
Hamming shortlist (200) → int8 rescore → max-pool to docs.

Integrity: `src/search/model-integrity.js` pins `onnx/model.onnx`,
`tokenizer.json`, `tokenizer_config.json` by sha256 at a fixed HF revision;
CI verifies at snapshot build.

## 3. Hard criteria (gates — numbers or it doesn't ship)

### Performance
| Metric | Gate | Baseline source |
| --- | --- | --- |
| Index-build embedding throughput (chunks/s, batch=64, full corpus shape) | **≥ 2× transformers.js** on arm64 Mac; **≥ 5×** vs the WASM fallback on Intel | **Measured 2026-06-11 (phase 3, arm64 M-series, release build, the committed 2k-chunk corpus): native 26,636 chunks/s vs transformers.js 9,929 → 2.68×. GATE MET.** **Intel (mm18, phase 5): native codes 12,898/s, f32 9.4–13.7k/s vs transformers.js 3,953–3,966/s → 3.3–3.5× — with a premise correction: the WASM-forced and native-ort baselines are INDISTINGUISHABLE (the bottleneck is transformers.js's JS tokenizer, not ort inference, for a static EmbeddingBag model), so the literal ≥5×-vs-WASM target was mis-modeled; the measured 3.3–3.5× end-to-end Intel win is the honest number.** `bun test/benchmarks/embed-bench.js` |
| Query-time single embed p50 | **≤ 1 ms** on arm64 Mac, ≤ 3 ms Linux arm64 (it is one tokenization + ≤~64 row-sums) | **Measured: p50 0.021 ms, p95 0.089 ms (47× under the gate); transformers.js baseline p50 0.093 ms.** `test/benchmarks/embed-bench.js` |
| Boundary | batch API crosses FFI **once per batch** (texts in, packed f32 matrix out, 16-byte-aligned per contract v0 — Float32Array view without copy-realignment) | p0/ffi-bridge.md |

### Memory
- Embedding matrix is **mmap'd, never heap-copied** (`mmap` + `MADV_SEQUENTIAL`
  off; matrix ≈ vocab×512×4 B). Process peak RSS attributable to the embedder
  **≤ matrix size + 32 MiB** during a full index build (measured the way the
  p0 leak gate measures: RSS before/after, full batch loop).
- **Zero per-call heap allocation on the hot loop** (token-id and pooling
  buffers reused; one result allocation per batch — the contract-v0 buffer).
- Tokenizer tables built once at load; load time ≤ 500 ms.

### Acceleration
- **Amended (Phase 2, 2026-06-11)** — the probed graph semantics (§6b) made
  bit-exactness attainable, which inverts the original
  tolerance-because-SIMD-reorders rationale: **bit-equality is now the
  contract, and acceleration may only exist where it preserves it.** The
  per-dim accumulation chains are independent, so vectorizing ACROSS dims
  (auto-vectorization, SIMD lanes, or elementwise vDSP_vadd) keeps every
  chain sequential and is allowed; the L2-norm sum of squares is ONE chain
  and stays scalar-sequential. Swift never reassociates float math, so the
  portable loop is exact on every platform; vDSP is deferred until a
  measured phase-3 bottleneck demands it.
- The accumulation order is fixed and documented in Pooling.swift: f32
  sequential row adds in bag order → f32 divide by count → f32 sequential
  sum of squares → f32 sqrt (IEEE-correctly-rounded) → f32 divide.
- Quantizers (sign-bit, int8+scale) move native in the same phase: they are
  trivially parallel and keep the f32 → storage path on one side of the
  boundary. Their outputs ARE bit-exact gates (comparisons and clamps only).
  *Done in Phase 2* — including the ECMA Math.round mirror (half toward +∞;
  Swift's `.toNearestOrAwayFromZero` is wrong at negative halves, and naive
  `floor(x+0.5)` double-rounds at 0.49999999999999994).

### Parity / determinism
- **Vectors**: per-component |Δ| ≤ 1e-5 against the JS/onnx reference on a
  recorded fixture set (≥ 2k real corpus chunks, committed as
  `test/fixtures/embed-parity/` inputs + reference vectors generated once by
  the current pipeline).
  **Outcome (Phase 2, 2026-06-11): exceeded — BIT-EXACT** (Float byte
  equality) on all 180 case fixtures (CI native matrix, subset artifact)
  and all 2,000 corpus chunks (full artifact, local/snapshot). The 1e-5
  bound remains the documented fallback only if a future platform
  disproves IEEE-correct f32 sqrt/divide.
- **Quantized codes**: bit-identical (binary) and byte-identical (int8+scale)
  for vectors within tolerance — if a component sits exactly on a sign/scale
  boundary the fixture is replaced, not the gate.
- **Retrieval**: NDCG@10 / MRR on the golden eval (`bun run eval:search`)
  unchanged within noise (±0.002), Hamming-shortlist overlap ≥ 99% on the
  fixture queries.
- **Cross-platform**: macOS-built and Linux-built vectors agree within the
  same 1e-5 (separate fixture run in the CI native matrix).

### Supply chain
- Zero new Swift dependencies for inference. The tokenizer is implemented
  in-repo (see §5 open decision D-0002-2 for the swift-parsing exception).
- **Weights artifact decision (D-0002-1)**: the pinned `model.onnx` is a
  protobuf; options are (a) a minimal ONNX-initializer reader (~protobuf
  varint walk for one tensor — no protobuf library), or (b) a one-time
  conversion at snapshot-build to a raw
  `[u32 vocab][u32 dims][f32…]` file, sha256-pinned next to the model files
  and shipped in snapshots. **Leaning (b)**: dumber artifact, trivially
  mmap-able, keeps the ONNX format knowledge out of the runtime; the
  converter runs under the existing model-integrity gate.
  **DECIDED 2026-06-11: (a)+(b) combined** — `scripts/gen-embed-matrix.mjs`
  does the varint walk at GENERATOR time (JS, dev/snapshot-build; the
  runtime never sees ONNX) and re-exports the "ADMX" v1 artifact: header
  {magic, version, flags(sparse), dtype, rows, dims, sourceSha256 of
  model.onnx} + optional ascending id table + 64-aligned row-major f32 LE,
  with a `.sha256` sidecar. Extraction is mandatory, not optional: the
  graph L2-normalizes its outputs, so raw row magnitudes are unrecoverable
  from inference (§6b). A committed SPARSE subset (the 608 token ids the
  tokenizer fixtures touch, ~1.2 MB) lets the CI native matrix gate vector
  parity without the 129 MB full artifact.

## 4. Packaging: internal subpackage first

- **`ADEmbed` target inside `swift/`** (depends: ADBase only; darwin leg may
  link Accelerate). NOT a separate SwiftPM package yet.
- Extraction criteria for a future standalone package (revisit when ALL
  hold): (1) a second consumer outside this repo exists, (2) the ABI surface
  has been stable for ≥ 2 release cycles, (3) the tokenizer covers more than
  the one model family we pin. Until then, internal keeps versioning,
  CI, and the parity harness in one place.
- Exports (contract v0): `ad_embed_batch(req,len)` — binary request
  (count + offsets + UTF-8 text blob), response payload = packed f32 matrix
  (16-byte aligned); `ad_embed_quantize(req,len)` for the code generation;
  `ad_embed_info()` (model id, dims, vocab, matrix sha) for the loader's
  provenance logging. JS dispatch module: `src/search/embedder-native.js`
  behind `APPLE_DOCS_NATIVE=embed`.

## 5. Open decisions

| ID | Question | Leaning |
| --- | --- | --- |
| D-0002-1 | Weights artifact: ONNX-initializer reader vs raw-matrix re-export at snapshot build | (b) re-export, sha256-pinned |
| D-0002-2 | Tokenizer implementation: from scratch vs `pointfreeco/swift-parsing` for tokenizer.json parsing | **DECIDED 2026-06-11: from scratch** — better than planned: the shipped target parses no JSON at all (vocab arrives as an id-ordered string array, config through the init signature), so swift-parsing never enters (§6a) |
| D-0002-3 | Which tokenizer algorithm does `potion-retrieval-32M` actually use (tokenizer.json declares it) — Unigram or WordPiece — and is normalization (NFC? lowercase? metaspace?) fully captured by tokenizer.json | **DECIDED 2026-06-11: WordPiece + BertNormalizer** (vocab 63,091, `##` continuation, max 100, `[UNK]`; clean_text + handle_chinese_chars + strip_accents:null + lowercase:true; BertPreTokenizer; 5 added tokens all `normalized:false`; TemplateProcessing inert under production `add_special_tokens:false`). Fully captured by tokenizer.json — but the **normative semantics are the installed transformers.js 4.2.0**, which diverges from the HF Rust reference in load-bearing ways (§6a) |
| D-0002-4 | Do gated registry models (EmbeddingGemma, Qwen3 — real transformers) stay on transformers.js | yes — out of scope; the kill list applies to the default model only, and the optionalDependency stays until those are dropped or P2b exists |
| D-0002-5 | **Default embedding model** — measured bake-off on our golden eval (no pre-committed threshold; the user decides on the numbers) | **DECIDED 2026-06-11: potion-retrieval-32M stays the default; the from-scratch Swift path (this RFC) proceeds unchanged.** The bake-off measured the cost wall before the quality columns completed, and the user vetoed the entire transformer-on-consumer class as operationally unacceptable (§5a). Transformer-quality models may only re-enter behind the **ship-vectors architecture** (§5c) — i.e. when consumers never embed documents — as gated registry options (D-0002-4). |
| D-0002-6 | **Inference runtime per platform** (only if a transformer model wins D-0002-5) | **Moot for the default path** (from-scratch Swift, runtime-free). The §5b matrix is retained as the decision record for any future ship-vectors revisit. |

### 5a. D-0002-5 — the model bake-off

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
- Any future quality re-match happens **only behind §5c ship-vectors**
  (build-host embeds once); the committed harness
  (`scripts/eval-embed-bakeoff.mjs`) and the bge/gemma-q8 registry rungs
  remain in place for that day.

### 5b. D-0002-6 — runtime matrix (doctrine: SOTA on macOS AND Linux)

The production platform doctrine (recorded user decision, 2026-06-11): the
project runs state-of-the-art performance/efficiency/accuracy on BOTH
macOS and Linux; a cloud relocation of the public instance is a
later-stage, RFC-triggering iteration — no platform is demoted now.

| Runtime | Fit | Notes |
| --- | --- | --- |
| **From-scratch Swift** (this RFC's core) | static models (potion class) only | Runtime-free, Linux-perfect, µs-class; cannot run transformers |
| **Vendored ggml/llama.cpp** | transformer models, CPU both OSes | Official ggml-org EmbeddingGemma GGUFs (incl. QAT + dense modules); dependency-policy exception required (vendored C, BSD-class); **verification gate: open llama.cpp embedding-accuracy issue #19040** (Jan 2026, divergence vs transformers reference) must be re-checked on our parity fixtures before adoption |
| **onnxruntime C API via dlopen** | transformer models, CPU both OSes | The middle path: kills the napi/npm packaging mess (incl. the darwin-x64 gap) while keeping ORT's kernels; same dlopen discipline as the libzstd binding |
| **MLX / mlx-swift** | darwin (Metal); Linux only via CUDA (NVIDIA) | Not a CPU-serving answer; mlx-swift CUDA support is a proposal. Position: optional **build-host accelerator** (snapshot builds run on Apple-Silicon CI) — pairs with §5c. Claimed constant-RSS under concurrent users (second-hand, unverified here) |

### 5c. Ship-vectors option (orthogonal, either model)

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

## 6. Phases

1. **Spike — tokenizer parity harness** (no FFI): Swift CLI tool in the
   package tokenizing the fixture corpus; gate = token-id sequences identical
   to transformers.js on 100% of fixtures. Settles D-0002-3. *This is the
   highest-risk item; nothing else starts until it is green.*
   **Done 2026-06-11** — amended shape: a library target (`ADEmbed`) +
   Swift Testing gate instead of a CLI tool (strictly stronger: the gate
   runs in the three-runner CI native matrix on every push). Gate held —
   180 fixture cases, 100% token-id equality on the first full run. §6a.
2. **Matrix + pooling**: weights artifact (D-0002-1), mmap reader, mean-pool
   with both acceleration backends; vector parity gate on fixtures.
   **Done 2026-06-11** — gate exceeded: bit-exact vectors AND byte-exact
   sign/int8 codes on 180 case fixtures (CI) + 2,000 corpus chunks (full
   artifact). Backend plan amended (§3 Acceleration): one portable
   bit-exact kernel, vDSP deferred. §6b.
3. **FFI + dispatch**: `ad_embed_batch`, `embedder-native.js`, kill switch,
   batch-boundary benches; index-build throughput gate.
   **Done 2026-06-11** — gates met: 2.68× throughput, p50 0.021 ms, init
   54 ms, matrix mmap'd (RSS 193 MB total process with the 129 MB map).
   §6c.
4. **Quantizers + retrieval gates**: native sign/int8 codes, golden eval,
   cross-platform CI legs; `setup` uses native embedding when enabled.
   **Done 2026-06-11** — codes over the bridge (2.49× vs transformers.js),
   setup ordering fixed, and the equivalence gate: 831,216 chunks
   byte-identical, golden-eval metrics identical. §6d.
5. **Default flip + kills**: native-by-default one release cycle → remove
   transformers/onnxruntime for the default model path (D-0002-4 caveat).
   **Flip shipped 2026-06-11** — `APPLE_DOCS_NATIVE` unset/'' now means
   native-on; `off` is the loudly-documented escape hatch. The soak cycle
   starts with the next release; the kills stay gated on it. §6e.

### 6a. Phase-1 record — tokenizer parity (done 2026-06-11)

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
at 100%. The committed model copies stay pinned to `PINNED_MODEL_FILES`;
raw ids are recorded (`[]` for empty — the `[0]` pad is embedder-level).

Deferred by design: FFI export + dispatch (phase 3), the runtime vocab
artifact format (phase 3 — the id-ordered array is its prototype), matrix
+ pooling (phase 2), performance gates (phase 2).

### 6b. Phase-2 record — matrix + pooling (done 2026-06-11)

Deliverables: `swift/Sources/ADEmbed/{MatrixArtifact,Pooling,Quantize,
Embedder}.swift` (Foundation-free; mmap via raw Darwin/Glibc syscalls),
`scripts/gen-embed-matrix.mjs` (protobuf walk + ADMX v1 export, full +
sparse-subset modes), `scripts/gen-embed-fixtures.mjs` (case + 2k-corpus
legs through the EXACT production embed path), committed
`test/fixtures/embed-parity/` (~7.6 MB: sparse matrix subset, case/corpus
vectors + codes, re-derived chunk texts, provenance index), the drift alarm
`test/unit/search/embed-parity-fixtures.test.js`, and the Swift gates in
`ADEmbedTests`.

**The graph finding that shaped the phase**: potion's model.onnx is NOT a
plain EmbeddingBag — probing single-token bags against raw initializer rows
proved the output is **f32-sequential mean → f32 L2-normalize**, bit-exact
across bag sizes (f64 accumulation drifts ~1.5e-8). Consequences:
- raw row magnitudes are unrecoverable from inference → initializer
  extraction is mandatory (D-0002-1);
- outputs are unit-norm → the JS path correctly adds no normalization, and
  both quantizers are scale-invariant by construction;
- bit-exactness became attainable → §3's parity and acceleration contracts
  were amended (bit-equality is the contract; portable kernel only).

Corpus fixtures: chunk text is not stored in the DB (`text: null` in the
indexer), so the 2,000 chunks are re-derived through the indexer's own path
(lowest document ids → `getSectionsByDocumentIds` → `chunkDocument`,
(docId, ord) order) and committed alongside their vectors — regenerable,
provenance-stamped (transformers 4.2.0 + onnxruntime-node 1.24.3 + model
sha; the WASM ort fallback is rejected outright by the generators since it
is a different runtime).

Gate split: the CI native matrix runs the 180-case gate against the
committed sparse subset (no model needed); the 2,000-chunk gate runs
wherever `matrix-v1.admx` exists (dev machines, future snapshot builds) via
`.enabled(if:)`. Regeneration protocol mirrors the tokenizer one: an
ort/transformers bump that changes reference bits fails the JS guard →
regenerate both generators' outputs → every Swift gate must re-pass.

Deferred to phase 3: FFI export + dispatch, snapshot-pipeline artifact
shipping, perf/RSS/load-time gates (the corpus gate's ~150 chunks/s is a
DEBUG-build, unbatched number — not a baseline).

### 6c. Phase-3 record — FFI + dispatch (done 2026-06-11)

Deliverables: `swift/Sources/ADCore/EmbedExports.swift`
(`ad_embed_init`/`ad_embed_batch`/`ad_embed_reset`; ADCore now depends on
ADEmbed), `src/search/embedder-native.js` (never-throws builder, announce-
once, scratch batch packer), the `getEmbedder` insertion (default model
only, outside the try so a dispatch bug can't kill the transformers
fallback), `src/lib/admx.js` (shared protobuf walk + atomic artifact
writer), the JS↔FFI↔Swift round-trip test (CI: 180 cases bit-exact through
the bridge, no model needed), and `test/benchmarks/embed-bench.js`.

Decisions recorded:
- **State model**: one process-wide embedder behind a pthread mutex;
  re-init is idempotent-ignore; `ad_embed_reset` is a test seam. In-flight
  batches survive a reset because they hold their own matrix reference
  (munmap on last release) — row pointers never dangle.
- **On-demand weights artifact**: consumers derive `matrix-v1.admx` once
  from the snapshot-shipped pinned model.onnx (full
  `verifyPinnedModelFiles` first, temp+rename atomic). Snapshots do not
  grow. Phase-5 option: ship ADMX *instead of* model.onnx (−124 MB) once
  transformers.js dies for the default path.
- **No per-call JS fallback**: after a native embedder is built, embed
  errors THROW. The whole-embedder choice happened at build time; the
  query path catches and degrades to lexical, `index embeddings` rolls
  back its batch and stays resumable. Fusion's per-call fallback suits
  stateless math, not a stateful embedder.
- **Throughput work**: the 1.42× first probe was lifted to 2.68× by
  removing per-candidate allocations from the WordPiece greedy loop
  (flat-arena FNV-1a vocab table probed by (prefix, slice) pairs),
  gating `lowercaseMapping` behind `changesWhenLowercased`, and ASCII
  bails before NFD/ccc/Mn lookups — all under the bit-exact gates, which
  never flickered.

Measured (arm64 M-series, release, committed 2k corpus): native 26,636
chunks/s vs transformers.js 9,929 (2.68×); single p50 0.021 ms / p95
0.089 ms; init 54 ms (0.7 MB vocab marshal + mmap + table build); process
RSS 193 MB with the 129 MB matrix mapped. Pending: the Intel/WASM ≥5× leg
(needs mm18) and the formal RSS-attribution harness (both non-blocking;
production enablement is a later, separate decision).

### 6d. Phase-4 record — codes + retrieval equivalence (done 2026-06-11)

Deliverables: `ad_embed_batch_codes` (count × 580 B sign+int8 blobs — the
exact storage shapes, so the index path crosses 580 B/chunk instead of the
2 KB f32 vector plus a JS quantize pass), `embedBatchCodes`/`dims` on the
native embedder, the index-pipeline capability branch
(src/commands/index-embeddings.js — injected test embedders and the
transformers path untouched), `pregenerateMatrixArtifact` in `setup
--native` (both install paths), and `scripts/verify-embed-equivalence.mjs`.

**Setup ordering fix**: `installNativeBundle` previously ran AFTER the
semantic index build — a fresh install embedded via JS even with the kill
switch on. The bundle now lands first; the artifact pre-generates after
extraction (warn-only).

**The equivalence gate (the phase's retrieval proof)** — full live corpus,
single-backup methodology (two sequential backups of a moving DB seeded
the legs differently on the first attempt — the server processes write):

- 831,216 chunks: **0 blob mismatches, 0 unmatched rows, 0 anchor
  mismatches**, embed_dims equal — the native-built index is
  byte-identical to the JS-built index, hence retrieval-identical forever.
- Golden eval on both legs: all quality metrics (recall/ndcg/mrr, curated
  + anchor splits, all four configs) **identical to the last digit**; only
  wall-clock p50 differs.
- End-to-end `index embeddings --full` over 831k chunks: **2.09× faster**
  native (47 s vs 93–98 s — DB writes and chunking included).

Bench additions (arm64, release): codes throughput 24,820 chunks/s
(**2.49×** vs transformers.js 9,958; f32 leg 2.0–2.7× across runs); RSS
before init 43 MB → after full pass 194 MB — embedder-attributable
≈ 151 MB against the §3 ceiling of matrix + 32 MiB = 161 MB → **memory
gate met** (the matrix stays mmap'd; the attribution includes corpus
strings and JS runtime growth).

ABI stance recorded: growing the SYMBOLS table makes a STALE installed
bundle fail dlopen cleanly (JS serves, one warning) until `setup --native`
refreshes it — accepted; bundle and code ship together in releases.

Remaining for phase 5: snapshot-build native enablement, default flip +
one release cycle, transformers/onnxruntime kill for the default path
(snapshots may then ship ADMX instead of model.onnx, −124 MB), mm18 soak,
Intel/WASM ≥5× measurement.

### 6e. Phase-5 record — native-by-default (flip shipped 2026-06-11; kills gated)

**Flip semantics** (src/native/loader.js): unset/''/'1'/'on' → every
migrated module serves natively wherever the dylib + artifacts exist, JS
serves bit-identically otherwise; '0'/'off' → JS everywhere (the escape
hatch, documented in configuration.md, self-hosting.md, ops/.env.example,
and a release-notes callout); csv → exactly those modules. The full test
suite passed default-on with ZERO pinning needed — the never-throws
builders and bit-identical outputs absorbed the entire blast radius.

**Release machinery**:
- Stable snapshot builds (snapshot.yml) now build the dylib in-job and pin
  **`APPLE_DOCS_NATIVE: embed` at the JOB level** — transitional for one
  cycle (the archiver stays beta-first), and job-level so the
  build-twice determinism re-build runs the identical config.
- Local/beta builds (publish-beta-snapshot.mjs) inherit full default-on
  via the dev dylib — the archiver's beta-first enablement happens here.
- **ADMX is excluded from snapshot archives this cycle**
  (src/commands/snapshot.js filters matrix-v1.admx* after the models
  copy): the build host derives it under native-embed, but shipping
  +129 MB of poorly-compressing f32 against the release-asset ceiling
  must be a deliberate decision — it is the kill-step design below.
- Scripts that encoded "unset = off" were flipped in the same commit:
  verify-embed-equivalence leg A pins 'off'; embed-bench's baseline pins
  'off' and its dylib gate honors APPLE_DOCS_NATIVE_LIB (mm18 has only
  the installed bundle).

**Soak — LIVE 2026-06-11** (ops/runbooks/native-embed-soak.md, executed
end-to-end): snapshot-20260611-beta.3 published (after a size-guard catch:
the bake-off's cached gemma/bge had been shipping in `resources/models` —
snapshots now copy ONLY the active pinned model's subtree) and deployed to
mm18 via `ops deploy`. The Intel host derived `matrix-v1.admx` itself
(129 MB, during setup --native), services bootstrapped after the bundle
landed, healthz 200 local+edge, and both `embed`/`fusion: served by native`
announce in-process. Intel measurements (darwin-x64, installed universal
bundle): native codes 12,898 chunks/s, single p50 0.040 ms, init ~112 ms,
RSS-attributable ≈122 MB (≤ the 161 MB ceiling). Baselines: transformers.js
3,966/s (native ort) and 3,953/s with `APPLE_DOCS_ONNX_WASM=1` —
**indistinguishable, because the baseline bottleneck is the JS tokenizer,
not ort inference**, which corrects the original ≥5×-vs-WASM premise; the
honest Intel number is 3.3–3.5× end-to-end. Also observed in the wild: the
native archiver correctly refused an ustar-unrepresentable long path
(155+100 split) during the snapshot build and the JS writer served — pax
long-name support is a known archiver gap, tracked for a later cycle.

**Stage C — the kills (GATED on one clean native-by-default release
cycle, NOT executed)**: snapshots ship the ADMX artifact INSTEAD of
model.onnx (−124 MB; PINNED_MODEL_FILES pins the artifact + tokenizer
files; setup/model-integrity verify it; on-demand generation retires);
@huggingface/transformers + onnxruntime + the WASM fallback demote to
gated-models-only (D-0002-4); the default-model JS embed path is removed.
Entry criteria: one stable release built native, mm18 soak clean, no
field reports against the escape hatch.

### 6f. Stage-C design — the kills (EXECUTED 2026-06-11)

**Entry criteria disposition:** the operator compressed the gate by
manually dispatching the stable release (snapshot.yml workflow_dispatch,
run 27372218651 from pre-Stage-C main) — that release is the LAST
onnx-bearing snapshot, so consumers still receive one full compat cycle
before the first ADMX-only snapshot (the next build). mm18 soak was
clean at execution time; no escape-hatch reports existed.

**Execution record (commits 640ff86 / 0f200d9 / 994035b + docs):** as
designed below, plus the validation-driven additions — the release
build's model acquisition moved into model-integrity.js (pin-verified
direct huggingface fetches; transformers' from_pretrained had been the
de-facto CI downloader), `LEGACY_ONNX_SHA256` survives as the immutable
derivation source pin, and the escape-hatch docs now state plainly that
`off` means lexical-only for the default model (fusion/archive still
serve identically from JS). The 831k-chunk equivalence script retired
with its purpose fulfilled; the committed fixtures are the frozen
transformers reference and the replay guard is native-vs-fixtures.

**1. Snapshots ship ADMX instead of model.onnx (−124 MB).**
- The snapshot build (already native) runs `gen-embed-matrix --full`
  semantics via `ensureMatrixArtifact` and INCLUDES
  `matrix-v1.admx(.sha256)` in `resources/models/<hfId>/` while EXCLUDING
  `onnx/` (inverting the §6e filter). Net: −124 MB onnx + +129 MB admx ≈
  par on disk, −124 MB once the onnx leaves; admx compresses poorly but
  onnx leaves entirely.
- `PINNED_MODEL_FILES` (src/search/model-integrity.js) becomes
  {tokenizer.json, tokenizer_config.json, matrix-v1.admx}; the admx pin
  is stable because the artifact bytes are deterministic (proven §6b).
  `verifyPinnedModelFiles` keeps its shape.
- `ensureEmbeddingModel` probes via the NATIVE embedder (getEmbedder
  already dispatches); the release-build hard-fail path keys on the
  native embedder being available instead of transformers.
- Compat (one cycle): `ensureMatrixArtifact`'s derive-from-onnx path
  stays so consumers on older onnx-bearing snapshots keep working; it
  retires the cycle after.

**2. transformers.js / onnxruntime demotion (D-0002-4 caveat).**
- `getEmbedder`'s default-model path becomes native-or-null (lexical
  degradation) — the buildModel2Vec transformers branch is deleted along
  with `ensureOnnxRuntimeLoadable`'s WASM fallback FOR THE DEFAULT PATH.
  Every supported platform ships a dylib bundle, so null means "bundle
  missing", same degradation story as today without the dep.
- `@huggingface/transformers` + `onnxruntime-*` remain optionalDeps used
  ONLY by the gated feature-extraction registry entries (gemma/bge…);
  the WASM fallback moves inside that branch. knip ignoreDependencies
  unchanged.
- Fixture/guard impact: the tokenizer/embed-parity JS replay tests keep
  transformers as their reference — they already skipIf the dep/model is
  absent, so CI shape is unchanged.

**3. Cleanups riding along:** docs (configuration/self-hosting) drop the
"derived from model.onnx" language for new snapshots; `setup --skip-semantic`
note unchanged; RFC 0001 §3's "runtime dependencies to eliminate" item 1
gets its done-mark.

Execution is a single slice once the criteria hold; nothing here is
ambiguous enough to need re-design at that point.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Tokenizer mismatch long-tail (normalizers, byte-level quirks) | Phase-1 spike gates on 100% token-id equality before any math exists; fixtures drawn from real corpus incl. code snippets, CJK, emoji — **outcome: gate held on the first full run (§6a)** |
| Float-sum drift beyond 1e-5 under SIMD reordering | tolerance gate measured per backend in CI; if a backend can't hold 1e-5, its summation order gets fixed (pairwise/Kahan) before relaxing any gate |
| mmap on the data dir vs security policy | weights are DATA (read-only mmap, no PROT_EXEC) — loading data from DATA_DIR is fine; the code-loading prohibition (p0/security.md) is untouched |
| Setup regression if native absent on first install | dispatch defaults to JS; `setup` only uses native when the kill switch enables it — identical degradation story to fusion/archive |
| Intel macs (WASM today) see the biggest delta and the least CI coverage | darwin-universal artifact + the mm18 host itself as the soak target |

---
*Maintenance*: decisions D-0002-* get dated entries here as they settle;
phase completions update RFC 0001 §7 P2 with one line each.
