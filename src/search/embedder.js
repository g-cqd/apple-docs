/**
 * Lazy, process-cached query/document embedder backed by transformers.js
 * (the optional `@huggingface/transformers` dependency). Returns `null` when
 * the dependency or model is unavailable, so callers degrade to lexical-only.
 *
 * Two backends, selected by `APPLE_DOCS_EMBED_MODEL` via the registry below:
 *   - **model2vec** (default, `potion-retrieval-32M`): a static EmbeddingBag —
 *     tokenize → look up each token's row → mean-pool. No neural forward pass,
 *     so it's fast, fully deterministic (bit-identical across the snapshot
 *     determinism gate), and ships as a tiny offline model. This is the default
 *     and its behavior is unchanged.
 *   - **feature-extraction** (gated, separate snapshot): a small transformer
 *     (EmbeddingGemma / Qwen3-Embedding) run through a real forward pass, then
 *     mean/last-token pooled (pooling.js), Matryoshka-truncated, and
 *     L2-normalized. Higher ceiling, larger artifact — kept off the default.
 *
 * Offline-first. The snapshot ships the model under
 * `<dataDir>/resources/models/<modelId>/…`; transformers.js reads it from there
 * (localModelPath) at query time with no network. `allowRemoteModels` is off
 * unless `APPLE_DOCS_ALLOW_REMOTE_MODELS=1` (set during the CI snapshot build).
 *
 * The same model embeds documents (build time) and queries (run time) — the
 * vector space must match, so this single factory is the only embedder.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { meanPool, lastTokenPool, l2normalize, truncate } from './pooling.js'

// Model registry. `APPLE_DOCS_EMBED_MODEL` selects a key; `APPLE_DOCS_EMBED_DIMS`
// optionally Matryoshka-truncates a feature-extraction model. Adding a model is
// a registry entry — getEmbedder() needs no changes.
const REGISTRY = {
  'potion-retrieval-32M': {
    hfId: 'minishlab/potion-retrieval-32M',
    backend: 'model2vec',
    dims: 512,
  },
  'embeddinggemma-300m': {
    hfId: 'onnx-community/embeddinggemma-300m-ONNX',
    backend: 'feature-extraction',
    dims: 768,
    pooling: 'mean',
    // EmbeddingGemma's prompt templates (query vs. document asymmetry).
    queryPrefix: 'task: search result | query: ',
    docPrefix: 'title: none | text: ',
  },
  'Qwen3-Embedding-0.6B': {
    hfId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    backend: 'feature-extraction',
    dims: 1024,
    pooling: 'last',
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages\nQuery: ',
    docPrefix: '',
  },
}

const DEFAULT_MODEL = 'potion-retrieval-32M'
let cached // { embed, embedBatch } | null | undefined

/** Build-time accessor for the active spec (model-integrity, snapshot). */
export function resolveActiveSpec() {
  return resolveSpec()
}

/** Resolve the active model spec from env (falls back to the default). */
function resolveSpec() {
  const key = process.env.APPLE_DOCS_EMBED_MODEL || DEFAULT_MODEL
  const spec = REGISTRY[key] ?? REGISTRY[DEFAULT_MODEL]
  const wanted = Number.parseInt(process.env.APPLE_DOCS_EMBED_DIMS, 10)
  const targetDims = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, spec.dims) : spec.dims
  return { ...spec, targetDims }
}

// Resolve the directory that holds (or will hold) the model files. Precedence:
// explicit env override → the caller-threaded dataDir → the APPLE_DOCS_HOME
// default. Threading the real dataDir keeps this correct under `--home`.
function resolveModelsDir(explicit) {
  if (process.env.APPLE_DOCS_MODELS_DIR) return process.env.APPLE_DOCS_MODELS_DIR
  if (explicit) return explicit
  const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
  return join(home, 'resources', 'models')
}

function configureEnv(env, dir) {
  env.localModelPath = dir
  env.cacheDir = dir
  env.allowLocalModels = true
  env.allowRemoteModels = process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS === '1'
}

/**
 * @param {{ logger?: object, modelsDir?: string }} [opts]
 * @returns {Promise<{ embed(text: string, opts?: { isQuery?: boolean }): Promise<Float32Array>, embedBatch(texts: string[], opts?: { isQuery?: boolean }): Promise<Float32Array[]> } | null>}
 */
export async function getEmbedder({ logger, modelsDir } = {}) {
  if (cached !== undefined) return cached
  if (process.env.APPLE_DOCS_SEMANTIC === 'off') {
    cached = null
    return cached
  }
  const spec = resolveSpec()
  try {
    const tx = await import('@huggingface/transformers')
    configureEnv(tx.env, resolveModelsDir(modelsDir))
    cached = spec.backend === 'feature-extraction'
      ? await buildFeatureExtraction(tx, spec)
      : await buildModel2Vec(tx, spec)
  } catch (err) {
    logger?.debug?.(`semantic embedder unavailable (${err.message}) — lexical-only`)
    cached = null
  }
  return cached
}

/**
 * Static model2vec EmbeddingBag backend (the default). Tokenize → row lookup →
 * mean-pool, no neural forward pass. transformers.js may log "Unknown model
 * class model2vec, attempting to construct from base class" — it constructs and
 * runs correctly; we pin model_type so a future lib version can't reroute it.
 * Sign-quantization keys off each dim's sign (L2-scale invariant), so no
 * normalize step is needed and the additive `opts` (query/doc prefix) is
 * ignored — the static space is symmetric.
 */
async function buildModel2Vec(tx, spec) {
  const { AutoModel, AutoTokenizer, Tensor } = tx
  const model = await AutoModel.from_pretrained(spec.hfId, { config: { model_type: 'model2vec' }, dtype: 'fp32' })
  const tokenizer = await AutoTokenizer.from_pretrained(spec.hfId)
  const run = async (texts) => {
    const enc = await tokenizer(texts, { add_special_tokens: false, return_tensor: false })
    const ids = enc.input_ids.map(a => (a.length ? a : [0])) // EmbeddingBag needs ≥1 token
    const flat = ids.flat()
    const offsets = [0]
    for (let i = 0; i < ids.length - 1; i++) offsets.push(offsets[offsets.length - 1] + ids[i].length)
    const out = await model({
      input_ids: new Tensor('int64', BigInt64Array.from(flat.map(x => BigInt(x))), [flat.length]),
      offsets: new Tensor('int64', BigInt64Array.from(offsets.map(x => BigInt(x))), [offsets.length]),
    })
    const t = out.embeddings ?? Object.values(out).find(v => v?.dims)
    const dim = t.dims[t.dims.length - 1]
    const n = t.dims[0]
    const result = new Array(n)
    for (let i = 0; i < n; i++) result[i] = t.data.subarray(i * dim, (i + 1) * dim)
    return result
  }
  return {
    async embed(text) { return (await run([text ?? '']))[0] },
    async embedBatch(texts) {
      if (!texts || texts.length === 0) return []
      return run(texts.map(t => t ?? ''))
    },
  }
}

/**
 * Transformer feature-extraction backend (gated). Real forward pass →
 * mean/last-token pool over the attention mask → Matryoshka truncate →
 * L2-normalize. `opts.isQuery` selects the query vs. document prompt prefix
 * (asymmetric instruction-tuned models); a default of `false` keeps the
 * document side prefix-free unless the spec sets one.
 */
async function buildFeatureExtraction(tx, spec) {
  const { AutoModel, AutoTokenizer } = tx
  const model = await AutoModel.from_pretrained(spec.hfId, { dtype: spec.dtype ?? 'fp32' })
  const tokenizer = await AutoTokenizer.from_pretrained(spec.hfId)
  const applyPrefix = (text, isQuery) =>
    (isQuery ? (spec.queryPrefix ?? '') : (spec.docPrefix ?? '')) + (text ?? '')
  const run = async (texts, isQuery) => {
    const enc = await tokenizer(texts.map(t => applyPrefix(t, isQuery)), { padding: true, truncation: true })
    const out = await model({ input_ids: enc.input_ids, attention_mask: enc.attention_mask })
    const hidden = out.last_hidden_state ?? out.token_embeddings
      ?? Object.values(out).find(v => v?.dims?.length === 3)
    const [n, seq, dim] = hidden.dims
    const maskData = enc.attention_mask?.data
    const results = new Array(n)
    for (let i = 0; i < n; i++) {
      const seqData = hidden.data.subarray(i * seq * dim, (i + 1) * seq * dim)
      const mask = maskData ? maskRow(maskData, i, seq) : null
      const pooled = spec.pooling === 'last' ? lastTokenPool(seqData, dim, mask) : meanPool(seqData, dim, mask)
      results[i] = l2normalize(truncate(pooled, spec.targetDims))
    }
    return results
  }
  return {
    async embed(text, opts) { return (await run([text ?? ''], !!opts?.isQuery))[0] },
    async embedBatch(texts, opts) {
      if (!texts || texts.length === 0) return []
      return run(texts.map(t => t ?? ''), !!opts?.isQuery)
    },
  }
}

/** Extract row `i` of a packed [n × seq] attention mask as a 0/1 number array. */
function maskRow(maskData, i, seq) {
  const out = new Array(seq)
  const base = i * seq
  for (let t = 0; t < seq; t++) out[t] = Number(maskData[base + t]) ? 1 : 0
  return out
}

/** Test seam: drop the cached pipeline so a fresh (or injected) one is used. */
export function _resetEmbedder() {
  cached = undefined
}
