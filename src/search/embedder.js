/**
 * Lazy, process-cached query/document embedder backed by transformers.js
 * (the optional `@huggingface/transformers` dependency). Returns `null` when
 * the dependency or model is unavailable, so callers degrade to lexical-only.
 *
 * Offline-first. The snapshot ships the model2vec model under
 * `<dataDir>/resources/models/<modelId>/…`; transformers.js reads it from there
 * (localModelPath) at query time with no network. A missing local model leaves
 * the tier dormant rather than reaching for the network — `allowRemoteModels`
 * is off unless `APPLE_DOCS_ALLOW_REMOTE_MODELS=1` (set during the CI snapshot
 * build, where a one-time HF download lands in the SAME directory: the FileCache
 * write layout is byte-for-byte identical to the localModelPath read layout, so
 * the downloaded files ship straight into the snapshot).
 *
 * The same model embeds documents (build time) and queries (run time) — the
 * vector space must match, so this single factory is the only embedder.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const MODEL = 'minishlab/potion-retrieval-32M'
let cached // { embed } | null | undefined

// Resolve the directory that holds (or will hold) the model files. Precedence:
// explicit env override → the caller-threaded dataDir → the APPLE_DOCS_HOME
// default. Threading the real dataDir keeps this correct under `--home`, where
// the env var isn't set.
function resolveModelsDir(explicit) {
  if (process.env.APPLE_DOCS_MODELS_DIR) return process.env.APPLE_DOCS_MODELS_DIR
  if (explicit) return explicit
  const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
  return join(home, 'resources', 'models')
}

/**
 * @param {{ logger?: object, modelsDir?: string }} [opts]
 * @returns {Promise<{ embed(text: string): Promise<Float32Array> } | null>}
 */
export async function getEmbedder({ logger, modelsDir } = {}) {
  if (cached !== undefined) return cached
  if (process.env.APPLE_DOCS_SEMANTIC === 'off') {
    cached = null
    return cached
  }
  try {
    const { AutoModel, AutoTokenizer, Tensor, env } = await import('@huggingface/transformers')
    const dir = resolveModelsDir(modelsDir)
    env.localModelPath = dir
    env.cacheDir = dir
    env.allowLocalModels = true
    env.allowRemoteModels = process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS === '1'

    // model2vec is a static EmbeddingBag: tokenize → look up each token's row
    // in the embedding matrix → mean-pool over the offsets. No neural forward
    // pass, so it's ~180× faster than MiniLM, fully deterministic, and (after
    // sign-quantization) scores higher recall. transformers.js may log
    // "Unknown model class model2vec, attempting to construct from base
    // class" — it constructs and runs correctly; we pin model_type so a future
    // lib version can't silently route it elsewhere. Sign-quantization keys off
    // each dim's sign, invariant to L2 scaling, so no normalize step is needed.
    const model = await AutoModel.from_pretrained(MODEL, { config: { model_type: 'model2vec' }, dtype: 'fp32' })
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL)
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
    cached = {
      async embed(text) { return (await run([text ?? '']))[0] },
      async embedBatch(texts) {
        if (!texts || texts.length === 0) return []
        return run(texts.map(t => t ?? ''))
      },
    }
  } catch (err) {
    logger?.debug?.(`semantic embedder unavailable (${err.message}) — lexical-only`)
    cached = null
  }
  return cached
}

/** Test seam: drop the cached pipeline so a fresh (or injected) one is used. */
export function _resetEmbedder() {
  cached = undefined
}
