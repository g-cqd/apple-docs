/**
 * Lazy, process-cached query/document embedder backed by transformers.js
 * (the optional `@huggingface/transformers` dependency). Returns `null` when
 * the dependency or model is unavailable, so callers degrade to lexical-only.
 *
 * Offline-first. The snapshot ships the q8 ONNX model under
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

const MODEL = 'Xenova/all-MiniLM-L6-v2'
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
    const { pipeline, env } = await import('@huggingface/transformers')
    const dir = resolveModelsDir(modelsDir)
    env.localModelPath = dir
    env.cacheDir = dir
    env.allowLocalModels = true
    env.allowRemoteModels = process.env.APPLE_DOCS_ALLOW_REMOTE_MODELS === '1'
    const extract = await pipeline('feature-extraction', MODEL, { dtype: 'q8' })
    cached = {
      async embed(text) {
        const out = await extract(text ?? '', { pooling: 'mean', normalize: true })
        return out.data
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
