/**
 * Lazy, process-cached query/document embedder. Returns `null` when the
 * model is unavailable, so callers degrade to lexical-only.
 *
 * Two backends, selected by `APPLE_DOCS_EMBED_MODEL` via the registry below:
 *   - **model2vec** (default, `potion-retrieval-32M`): a static EmbeddingBag —
 *     tokenize → look up each token's row → mean-pool → L2-normalize.
 *     Implemented in pure JS (model2vec-static.js) directly over the shipped
 *     tokenizer.json + model.onnx — no transformers.js, no ONNX runtime, no
 *     native modules. That keeps it working inside the `bun build --compile`
 *     binary (where onnxruntime-node's napi binding and sharp cannot load)
 *     and drops ~1.5 s of runtime import from every query-path cold start.
 *   - **feature-extraction** (gated, separate snapshot): a small transformer
 *     (EmbeddingGemma / Qwen3-Embedding) run through transformers.js with a
 *     real forward pass, then mean/last-token pooled (pooling.js),
 *     Matryoshka-truncated, and L2-normalized. Higher ceiling, larger
 *     artifact — kept off the default.
 *
 * Offline-first. The snapshot ships the model under
 * `<dataDir>/resources/models/<modelId>/…`. When files are missing, they are
 * fetched from huggingface.co and pin-verified — enabled by default
 * (`APPLE_DOCS_FETCH_MODELS`, CLI `--no-fetch-models` to opt out; the legacy
 * `APPLE_DOCS_ALLOW_REMOTE_MODELS` env still wins when set).
 *
 * The same model embeds documents (build time) and queries (run time) — the
 * vector space must match, so this single factory is the only embedder.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { config } from '../config.js'
import { meanPool, lastTokenPool, l2normalize, truncate } from './pooling.js'
import { loadStaticModel2Vec, Q8_FILENAME } from './model2vec-static.js'
import { ensureModelFiles } from './model-fetch.js'

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

/**
 * Whether missing model files may be fetched from huggingface.co.
 * Precedence: explicit per-call option (CLI flag) → legacy
 * `APPLE_DOCS_ALLOW_REMOTE_MODELS` env (read live — CI scripts set it at
 * runtime) → `APPLE_DOCS_FETCH_MODELS` config default (true).
 */
function fetchModelsAllowed(explicit) {
  if (explicit != null) return !!explicit
  const legacy = process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS
  if (legacy != null) return ['1', 'true', 'on', 'yes'].includes(legacy.trim().toLowerCase())
  return config.APPLE_DOCS_FETCH_MODELS !== false
}

function configureEnv(env, dir, allowFetch) {
  env.localModelPath = dir
  env.cacheDir = dir
  env.allowLocalModels = true
  env.allowRemoteModels = allowFetch
}

let onnxFallbackInstalled = false
let sharpStubInstalled = false
let lastError = null

/**
 * Why the last `getEmbedder()` call returned null (or null when it
 * succeeded). Lets callers surface the real failure instead of guessing.
 */
export function getEmbedderLastError() {
  return lastError
}

/**
 * transformers.js eagerly imports `onnxruntime-node`, whose napi binding
 * does not ship for every platform (notably darwin-x64 — the import
 * throws "Cannot find module …/darwin/x64/onnxruntime_binding.node"
 * before any backend selection can happen). When the native runtime
 * can't load, alias the specifier to the API-compatible
 * `onnxruntime-web` WASM runtime via a Bun module plugin. model2vec is
 * a static lookup + mean-pool, so WASM throughput is more than enough.
 * `APPLE_DOCS_ONNX_WASM=1` forces the fallback (used by tests and for
 * diagnosing WASM-path issues on platforms with a native binding).
 */
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
 * transformers.js eagerly imports `sharp` (image decoding) whose native
 * binding cannot load inside the compiled binary. Text pipelines never touch
 * it, so when the transformers.js import fails on sharp, alias sharp to a
 * throwing stub and retry. Only the gated feature-extraction backend reaches
 * this — the default model2vec path never imports transformers.js at all.
 */
async function importTransformers(logger) {
  try {
    return await import('@huggingface/transformers')
  } catch (err) {
    if (sharpStubInstalled || !/sharp/i.test(err?.message ?? '')) throw err
    Bun.plugin({
      name: 'sharp-stub',
      setup(build) {
        build.module('sharp', () => ({
          exports: {
            default: () => { throw new Error('sharp is unavailable in this build (image pipelines unsupported)') },
          },
          loader: 'object',
        }))
      },
    })
    sharpStubInstalled = true
    logger?.debug?.('sharp native binding unavailable — image pipelines stubbed out (text embedding unaffected)')
    return await import('@huggingface/transformers')
  }
}

// Files the static model2vec backend needs. The matrix is satisfied by
// EITHER the compact q8 sidecar (what snapshots ship) or the fp32 ONNX
// export (the HF fetch layout) — only fetch model.onnx when neither exists.
// tokenizer_config.json is unused at runtime but pinned, so keep the
// on-disk layout complete.
function model2vecRequiredFiles(modelDir) {
  const files = ['tokenizer.json', 'tokenizer_config.json']
  if (!existsSync(join(modelDir, Q8_FILENAME))) files.push('onnx/model.onnx')
  return files
}

/**
 * @param {{ logger?: object, modelsDir?: string, fetchModels?: boolean }} [opts]
 * @returns {Promise<{ embed(text: string, opts?: { isQuery?: boolean }): Promise<Float32Array>, embedBatch(texts: string[], opts?: { isQuery?: boolean }): Promise<Float32Array[]> } | null>}
 */
export async function getEmbedder({ logger, modelsDir, fetchModels } = {}) {
  if (cached !== undefined) return cached
  if (process.env.APPLE_DOCS_SEMANTIC === 'off') {
    lastError = 'semantic search disabled (APPLE_DOCS_SEMANTIC=off)'
    cached = null
    return cached
  }
  const spec = resolveSpec()
  const allowFetch = fetchModelsAllowed(fetchModels)
  const dir = resolveModelsDir(modelsDir)
  try {
    if (spec.backend === 'feature-extraction') {
      await ensureOnnxRuntimeLoadable(logger)
      const tx = await importTransformers(logger)
      configureEnv(tx.env, dir, allowFetch)
      if (onnxFallbackInstalled) {
        // Single-threaded WASM: Bun's worker support and ort-web's
        // threaded dispatch don't agree on every platform.
        try { tx.env.backends.onnx.wasm.numThreads = 1 } catch {}
      }
      cached = await buildFeatureExtraction(tx, spec)
    } else {
      // Default static path: no transformers.js, no ONNX runtime — works in
      // the compiled binary and starts in the time it takes to read the files.
      const modelDir = join(dir, spec.hfId)
      await ensureModelFiles({ modelsDir: dir, hfId: spec.hfId, files: model2vecRequiredFiles(modelDir), allowFetch, logger })
      cached = await loadStaticModel2Vec({ modelDir })
    }
    lastError = null
  } catch (err) {
    lastError = err.message
    logger?.debug?.(`semantic embedder unavailable (${err.message}) — lexical-only`)
    cached = null
  }
  return cached
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
  lastError = null
}
