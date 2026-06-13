# RFC 0002 — Swift-native embedder (model2vec inference in ADEmbed)

- **Status: COMPLETE** (2026-06-12). Default model native-only; snapshots
  ship the ADMX artifact; transformers/onnxruntime demoted to gated models;
  embedding v2 + the reference flip executed.
- Parent: [RFC 0001 §7 P2](0001-swift-native-transition.md) — this is the P2
  contract.
- **Detailed execution + decision records**: [`records.md`](0002-swift-embedder/records.md)
  (the bake-off, runtime matrix, ship-vectors option, and the phase-1→5 +
  embedding-v2 records). This file is the concise contract + outcome.
- Repo-internal: like all of `rfcs/`, never built or indexed by the docs site.

## 1. Why this was the flagship

The embedder was the only module whose JS dragged an unfixable dependency
subtree: `@huggingface/transformers` (optional) → `onnxruntime-node`/`-web`.
Costs it carried: a platform-binding matrix (onnxruntime ships no darwin-x64
napi binding — Intel macOS ran a single-threaded WASM fallback), the
heaviest third-party code in the tree for what is arithmetically a lookup
table (§2), and the dominant term in `apple-docs setup` (every install
re-embeds ~858k chunks locally).

**Killed on completion**: `@huggingface/transformers`,
`onnxruntime-node`/`-web`, the WASM fallback, and the darwin-x64 gap — for
the default model. (They remain optionalDeps for the gated transformer
registry entries; D-0002-4.)

## 2. What the pipeline computes (normative reference)

Model: `minishlab/potion-retrieval-32M` (model2vec, static).

1. **Tokenize** with the model's `tokenizer.json` (WordPiece +
   BertNormalizer; `add_special_tokens: false`); empty input pads to `[0]`.
2. **EmbeddingBag**: token ids → row lookups in a `[vocab × 512]` f32
   matrix → **f32-sequential mean → f32 L2-normalize** (no transformer
   forward pass; the graph normalizes, so raw row magnitudes are
   unrecoverable from inference — the matrix must be extracted, not inferred).
3. Output: a unit-norm 512-dim `Float32Array` per sample.

Downstream quantization (`src/search/embedding.js`): sign-bit binary codes
(64 B) + int8-with-f32-scale rescore codes (`dims + 4` B), stored per chunk
in `document_chunks`. Query-time: Hamming shortlist → int8 rescore →
max-pool to docs.

## 3. Hard criteria (the gates — all MET)

| Gate | Target | Result |
| --- | --- | --- |
| Index-build throughput | ≥ 2× transformers.js (arm64) | **2.68×** (26,636 vs 9,929 chunks/s); Intel **3.3–3.5×** end-to-end (the ≥5×-vs-WASM target was mis-modeled — the baseline bottleneck is the JS tokenizer, not ort) |
| Query single-embed p50 | ≤ 1 ms arm64 | **0.021 ms** (47× under) |
| Vector parity | \|Δ\| ≤ 1e-5 vs JS/onnx | **bit-exact** (Float byte equality) on 180 cases + 2,000 corpus chunks; codes byte-identical |
| Retrieval equivalence | NDCG/MRR within ±0.002 | **831,216 chunks byte-identical**; golden eval identical to the last digit |
| Memory | matrix mmap'd, RSS ≤ matrix + 32 MiB | **met** (matrix never heap-copied; ≈151 MB attributable vs 161 MB ceiling) |
| Boundary | one FFI crossing per batch | met (texts in, packed f32 / 580 B codes out, 16-aligned, contract v0) |

**Acceleration stance** (amended Phase 2): bit-equality is the contract, so
acceleration may only exist where it preserves it. The portable Swift kernel
is exact on every platform (Swift never reassociates float math); per-dim
chains are independent so vectorizing *across* dims is allowed, the L2 sum
of squares stays scalar-sequential. vDSP deferred until a measured
bottleneck demands it. The int8 quantizer mirrors ECMA `Math.round` (half
away from zero since v2).

## 4. Packaging

`ADEmbed` is an internal target inside `swift/` (depends ADBase only), NOT a
standalone SwiftPM package — extract only when a second external consumer
exists, the ABI is stable ≥ 2 cycles, and the tokenizer covers more than the
one pinned model family. Exports (contract v0): `ad_embed_init`,
`ad_embed_batch`, `ad_embed_batch_codes`, `ad_embed_reset`
(`swift/Sources/ADCore/EmbedExports.swift`); JS dispatch
`src/search/embedder-native.js` behind `APPLE_DOCS_NATIVE=embed`.

## 5. Decisions (all settled — detail in records.md)

| ID | Question | Decision |
| --- | --- | --- |
| D-0002-1 | Weights artifact format | **(a)+(b)**: `gen-embed-matrix.mjs` does the ONNX-initializer varint walk at generator time and exports the raw mmap-able **ADMX** artifact (sha256-pinned); the runtime never sees ONNX. A committed sparse subset gates CI vector parity without the 129 MB full artifact |
| D-0002-2 | Tokenizer impl | **from scratch** — the shipped target parses no JSON at all (vocab as an id-ordered array); swift-parsing never enters |
| D-0002-3 | Tokenizer algorithm | **WordPiece + BertNormalizer** (vocab 63,091); the normative reference is the installed transformers.js 4.2.0 (which diverges from HF-Rust in load-bearing ways — mirrored deliberately, see records) |
| D-0002-4 | Gated transformer models | stay on transformers.js (optionalDeps); the kill list is default-model-only |
| D-0002-5 | Default model | **potion-retrieval-32M stays** — the bake-off measured a 400–1,900× cost wall; the user vetoed the transformer-on-consumer class. Transformers may only re-enter behind ship-vectors (records) |
| D-0002-6 | Inference runtime | **moot for the default path** (from-scratch Swift, runtime-free); the runtime matrix is kept as the record for a future ship-vectors revisit |

## 6. Outcome

Shipped across phases 1→5 (2026-06-11) + embedding v2 (2026-06-12) — full
records in [`records.md`](0002-swift-embedder/records.md):

- **`ADEmbed`** (Foundation-free): tokenizer (WordPiece + BertNormalizer,
  byte-keyed vocab, generated Unicode tables), ADMX matrix mmap reader, the
  bit-exact mean→normalize→quantize kernel. Exports via ADCore/EmbedExports.
- **Native-by-default** (`embed` token) with bit-identical JS fallback; the
  831k-chunk equivalence proof makes the native index retrieval-identical.
- **Stage-C kills EXECUTED**: snapshots ship ADMX instead of model.onnx
  (−124 MB); transformers/onnxruntime are gated-only.
- **Embedding v2 + reference flip**: the Swift tokenizer is now its own
  reference (fixtures regenerate from `ad-embed-dump`; transformers.js
  survives as the divergence recorder). Astral-CJK neighbor recovery
  (cos(`𠮷stack`,`stack`) −0.02 → 0.99); mrr strictly up; `embed_version`
  stamping force-fulls a re-embed on mismatch.

Risks all retired (records.md). Improvement candidates that arose here are
in RFC 0001 §10 — (A) embedding v2 (done), (F) chunking parameters (NO-GO).

---
*Maintenance*: this RFC is complete; future embedder changes are §10
improvement slices (RFC 0001) with their own records. Full history in
[`records.md`](0002-swift-embedder/records.md) + git.
