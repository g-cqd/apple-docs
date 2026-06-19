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
import { isNativeEnabled } from '../native/loader.js'
import { buildNativeModel2Vec } from './embedder-native.js'
import { l2normalize, lastTokenPool, meanPool, truncate } from './pooling.js'

// Model registry. `APPLE_DOCS_EMBED_MODEL` selects a key; `APPLE_DOCS_EMBED_DIMS`
// optionally Matryoshka-truncates a feature-extraction model. Adding a model is
// a registry entry — getEmbedder() needs no changes.
/** @type {Record<string, any>} */
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
  // Same weights at the QAT int8 dtype — the realistic CPU-serving point
  // (fp32 above is the quality ceiling).
  'embeddinggemma-300m-q8': {
    hfId: 'onnx-community/embeddinggemma-300m-ONNX',
    backend: 'feature-extraction',
    dims: 768,
    dtype: 'q8',
    pooling: 'mean',
    queryPrefix: 'task: search result | query: ',
    docPrefix: 'title: none | text: ',
  },
  // The 33M/384-dim middle rung: real-transformer retrieval quality at
  // ~1/10th of gemma's compute. BGE pools the [CLS] token and prefixes
  // queries only.
  'bge-small-en-v1.5': {
    hfId: 'Xenova/bge-small-en-v1.5',
    backend: 'feature-extraction',
    dims: 384,
    pooling: 'cls',
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    docPrefix: '',
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
/** @type {any} */
let cached // { embed, embedBatch } | null | undefined

/** Build-time accessor for the active spec (model-integrity, snapshot). */
export function resolveActiveSpec() {
  return resolveSpec()
}

/** Resolve the active model spec from env (falls back to the default). */
function resolveSpec() {
  const key = process.env.APPLE_DOCS_EMBED_MODEL || DEFAULT_MODEL
  const spec = REGISTRY[key] ?? REGISTRY[DEFAULT_MODEL]
  const wanted = Number.parseInt(process.env.APPLE_DOCS_EMBED_DIMS ?? '', 10)
  const targetDims = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, spec.dims) : spec.dims
  return { ...spec, targetDims }
}

// Resolve the directory that holds (or will hold) the model files. Precedence:
// explicit env override → the caller-threaded dataDir → the APPLE_DOCS_HOME
// default. Threading the real dataDir keeps this correct under `--home`.
/** @param {string} [explicit] */
function resolveModelsDir(explicit) {
  if (process.env.APPLE_DOCS_MODELS_DIR) return process.env.APPLE_DOCS_MODELS_DIR
  if (explicit) return explicit
  const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
  return join(home, 'resources', 'models')
}

/** @param {any} env @param {string} dir */
function configureEnv(env, dir) {
  env.localModelPath = dir
  env.cacheDir = dir
  env.allowLocalModels = true
  env.allowRemoteModels = process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS === '1'
}

/**
 * @param {{ logger?: any, modelsDir?: string }} [opts]
 * @returns {Promise<{ embed(text: string, opts?: { isQuery?: boolean }): Promise<Float32Array>, embedBatch(texts: string[], opts?: { isQuery?: boolean }): Promise<Float32Array[]> } | null>}
 */
export async function getEmbedder({ logger, modelsDir } = {}) {
  if (cached !== undefined) return cached
  if (process.env.APPLE_DOCS_SEMANTIC === 'off') {
    cached = null
    return cached
  }
  const spec = resolveSpec()

  if (spec.backend !== 'feature-extraction') {
    // The DEFAULT model is native-only since Stage C (RFC 0002 §6f): the
    // bit-exact Swift pipeline serves wherever the dylib + ADMX artifact
    // exist, and the semantic tier degrades to lexical-only otherwise —
    // the JS/transformers model2vec path is gone. The builder never throws.
    if (isNativeEnabled('embed')) {
      cached = await buildNativeModel2Vec(spec, resolveModelsDir(modelsDir))
    } else {
      logger?.info?.('semantic tier disabled: APPLE_DOCS_NATIVE is off and the default embed path is native-only (lexical-only search)')
      cached = null
    }
    return cached
  }

  // Gated transformer models (D-0002-4) keep the transformers.js path —
  // each would need its own tokenizer family natively, and none is the
  // shipped default.
  try {
    await ensureOnnxRuntimeLoadable(logger)
    const tx = /** @type {any} */ (await import('@huggingface/transformers'))
    configureEnv(tx.env, resolveModelsDir(modelsDir))
    if (onnxFallbackInstalled) {
      // Single-threaded WASM: Bun's worker support and ort-web's
      // threaded dispatch don't agree on every platform.
      try {
        tx.env.backends.onnx.wasm.numThreads = 1
      } catch {}
    }
    cached = await buildFeatureExtraction(tx, spec)
  } catch (err) {
    logger?.debug?.(`semantic embedder unavailable (${err instanceof Error ? err.message : err}) — lexical-only`)
    cached = null
  }
  return cached
}

let onnxFallbackInstalled = false

/**
 * Gated-models-only since Stage C. transformers.js eagerly imports
 * `onnxruntime-node`, whose napi binding does not ship for every platform
 * (notably darwin-x64). When the native runtime can't load, alias the
 * specifier to the API-compatible `onnxruntime-web` WASM runtime via a Bun
 * module plugin. `APPLE_DOCS_ONNX_WASM=1` forces the fallback.
 */
/** @param {any} logger */
async function ensureOnnxRuntimeLoadable(logger) {
  if (onnxFallbackInstalled) return
  if (process.env.APPLE_DOCS_ONNX_WASM !== '1') {
    try {
      await import('onnxruntime-node')
      return
    } catch {
      // fall through to the WASM alias
    }
  }
  Bun.plugin({
    name: 'onnxruntime-node-wasm-fallback',
    setup(build) {
      build.module('onnxruntime-node', async () => ({
        exports: await import('onnxruntime-web'),
        loader: 'object',
      }))
    },
  })
  onnxFallbackInstalled = true
  logger?.info?.('onnxruntime native binding unavailable on this platform — using the WASM runtime (onnxruntime-web)')
}

/**
 * Transformer feature-extraction backend (gated). Real forward pass →
 * mean/last-token pool over the attention mask → Matryoshka truncate →
 * L2-normalize. `opts.isQuery` selects the query vs. document prompt prefix
 * (asymmetric instruction-tuned models); a default of `false` keeps the
 * document side prefix-free unless the spec sets one.
 */
/** @param {any} tx @param {any} spec */
async function buildFeatureExtraction(tx, spec) {
  const { AutoModel, AutoTokenizer } = tx
  const model = await AutoModel.from_pretrained(spec.hfId, { dtype: spec.dtype ?? 'fp32' })
  const tokenizer = await AutoTokenizer.from_pretrained(spec.hfId)
  const applyPrefix = (/** @type {any} */ text, /** @type {any} */ isQuery) => (isQuery ? (spec.queryPrefix ?? '') : (spec.docPrefix ?? '')) + (text ?? '')
  const run = async (/** @type {any[]} */ texts, /** @type {any} */ isQuery) => {
    const enc = await tokenizer(
      texts.map((t) => applyPrefix(t, isQuery)),
      { padding: true, truncation: true },
    )
    const out = await model({ input_ids: enc.input_ids, attention_mask: enc.attention_mask })
    const hidden = out.last_hidden_state ?? out.token_embeddings ?? Object.values(out).find((v) => v?.dims?.length === 3)
    const [n, seq, dim] = hidden.dims
    const maskData = enc.attention_mask?.data
    const results = new Array(n)
    for (let i = 0; i < n; i++) {
      const seqData = hidden.data.subarray(i * seq * dim, (i + 1) * seq * dim)
      const mask = maskData ? maskRow(maskData, i, seq) : null
      const pooled =
        spec.pooling === 'last'
          ? lastTokenPool(seqData, dim, mask)
          : spec.pooling === 'cls'
            ? Float32Array.from(seqData.subarray(0, dim)) // first token ([CLS])
            : meanPool(seqData, dim, mask)
      results[i] = l2normalize(truncate(pooled, spec.targetDims))
    }
    return results
  }
  return {
    async embed(/** @type {any} */ text, /** @type {any} */ opts) {
      return (await run([text ?? ''], !!opts?.isQuery))[0]
    },
    async embedBatch(/** @type {any[]} */ texts, /** @type {any} */ opts) {
      if (!texts || texts.length === 0) return []
      return run(
        texts.map((t) => t ?? ''),
        !!opts?.isQuery,
      )
    },
  }
}

/** Extract row `i` of a packed [n × seq] attention mask as a 0/1 number array.
 * @param {any} maskData @param {number} i @param {number} seq */
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
