/**
 * Lazy, process-cached query/document embedder backed by transformers.js
 * (the optional `@huggingface/transformers` dependency). Returns `null` when
 * the dependency or model is unavailable, so callers degrade to lexical-only.
 *
 * Offline-first: set `APPLE_DOCS_MODELS_DIR` to a directory containing the
 * shipped model and remote downloads are disabled. At build time (CI) the
 * default allows a one-time download from the HF hub.
 *
 * The same model embeds documents (build time) and queries (run time) — the
 * vector space must match, so this single factory is the only embedder.
 */

const MODEL = 'Xenova/all-MiniLM-L6-v2'
let cached // { embed } | null | undefined

/**
 * @param {{ logger?: object }} [opts]
 * @returns {Promise<{ embed(text: string): Promise<Float32Array> } | null>}
 */
export async function getEmbedder({ logger } = {}) {
  if (cached !== undefined) return cached
  if (process.env.APPLE_DOCS_SEMANTIC === 'off') {
    cached = null
    return cached
  }
  try {
    const { pipeline, env } = await import('@huggingface/transformers')
    if (process.env.APPLE_DOCS_MODELS_DIR) {
      env.localModelPath = process.env.APPLE_DOCS_MODELS_DIR
      env.allowRemoteModels = false
    }
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
