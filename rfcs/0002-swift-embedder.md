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
| Index-build embedding throughput (chunks/s, batch=64, full corpus shape) | **≥ 2× transformers.js** on arm64 Mac; **≥ 5×** vs the WASM fallback on Intel | measured before P2 starts and recorded in the RFC (TBD-baseline, owner: P2 spike) |
| Query-time single embed p50 | **≤ 1 ms** on arm64 Mac, ≤ 3 ms Linux arm64 (it is one tokenization + ≤~64 row-sums) | new micro-bench in `test/benchmarks/` |
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
- One internal API, two backends: **Accelerate/vDSP (`vDSP_vadd`/BLAS) on
  darwin**, **portable SIMD (`SIMD32<Float>` / manual unrolling) on Linux** —
  selected at compile time, never at the call site.
- The accumulation order MUST stay fixed and documented per backend: mean
  pooling is a float sum, and parity tolerances (below) assume a stable
  summation order per platform. SIMD reordering is allowed ONLY because the
  gate is tolerance-based, not bit-based — the tolerance is the contract.
- Quantizers (sign-bit, int8+scale) move native in the same phase: they are
  trivially parallel and keep the f32 → storage path on one side of the
  boundary. Their outputs ARE bit-exact gates (comparisons and clamps only).

### Parity / determinism
- **Vectors**: per-component |Δ| ≤ 1e-5 against the JS/onnx reference on a
  recorded fixture set (≥ 2k real corpus chunks, committed as
  `test/fixtures/embed-parity/` inputs + reference vectors generated once by
  the current pipeline).
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
| D-0002-2 | Tokenizer implementation: from scratch vs `pointfreeco/swift-parsing` for tokenizer.json parsing | from scratch first (the JSON subset + Unigram/WordPiece trie is small); swift-parsing only if the parser grows |
| D-0002-3 | Which tokenizer algorithm does `potion-retrieval-32M` actually use (tokenizer.json declares it) — Unigram or WordPiece — and is normalization (NFC? lowercase? metaspace?) fully captured by tokenizer.json | settle in the spike, FIRST |
| D-0002-4 | Do gated registry models (EmbeddingGemma, Qwen3 — real transformers) stay on transformers.js | yes — out of scope; the kill list applies to the default model only, and the optionalDependency stays until those are dropped or P2b exists |

## 6. Phases

1. **Spike — tokenizer parity harness** (no FFI): Swift CLI tool in the
   package tokenizing the fixture corpus; gate = token-id sequences identical
   to transformers.js on 100% of fixtures. Settles D-0002-3. *This is the
   highest-risk item; nothing else starts until it is green.*
2. **Matrix + pooling**: weights artifact (D-0002-1), mmap reader, mean-pool
   with both acceleration backends; vector parity gate on fixtures.
3. **FFI + dispatch**: `ad_embed_batch`, `embedder-native.js`, kill switch,
   batch-boundary benches; index-build throughput gate.
4. **Quantizers + retrieval gates**: native sign/int8 codes, golden eval,
   cross-platform CI legs; `setup` uses native embedding when enabled.
5. **Default flip + kills**: native-by-default one release cycle → remove
   transformers/onnxruntime for the default model path (D-0002-4 caveat).

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Tokenizer mismatch long-tail (normalizers, byte-level quirks) | Phase-1 spike gates on 100% token-id equality before any math exists; fixtures drawn from real corpus incl. code snippets, CJK, emoji |
| Float-sum drift beyond 1e-5 under SIMD reordering | tolerance gate measured per backend in CI; if a backend can't hold 1e-5, its summation order gets fixed (pairwise/Kahan) before relaxing any gate |
| mmap on the data dir vs security policy | weights are DATA (read-only mmap, no PROT_EXEC) — loading data from DATA_DIR is fine; the code-loading prohibition (p0/security.md) is untouched |
| Setup regression if native absent on first install | dispatch defaults to JS; `setup` only uses native when the kill switch enables it — identical degradation story to fusion/archive |
| Intel macs (WASM today) see the biggest delta and the least CI coverage | darwin-universal artifact + the mm18 host itself as the soak target |

---
*Maintenance*: decisions D-0002-* get dated entries here as they settle;
phase completions update RFC 0001 §7 P2 with one line each.
