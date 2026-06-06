/**
 * Optional semantic-search tier: binary embeddings + in-process Hamming scan.
 *
 * Dormant unless `document_vectors` is populated AND a query embedder is
 * available (the optional transformers.js dep, or an injected `ctx.embedder`)
 * AND `APPLE_DOCS_SEMANTIC !== 'off'`. When dormant, callers fall back to
 * lexical-only search (zero behavior change).
 */

import { quantize, hamming, VECTOR_BYTES } from './embedding.js'
import { getEmbedder } from './embedder.js'

// Per-DB packed vector store (WeakMap → no cross-instance collision, auto-GC).
// Invalidated cheaply by row count.
const caches = new WeakMap()

/** Cheap gate: vectors present and not explicitly disabled. */
export function isSemanticAvailable(db) {
  return process.env.APPLE_DOCS_SEMANTIC !== 'off'
    && typeof db?.getVectorCount === 'function'
    && db.getVectorCount() > 0
}

function loadVectors(db) {
  const count = db.getVectorCount()
  if (count === 0) { caches.delete(db); return null }
  const existing = caches.get(db)
  if (existing && existing.count === count) return existing
  const rows = db.getAllVectors()
  const ids = new Int32Array(rows.length)
  const packed = new Uint8Array(rows.length * VECTOR_BYTES)
  for (let i = 0; i < rows.length; i++) {
    ids[i] = rows[i].document_id
    packed.set(rows[i].vec, i * VECTOR_BYTES)
  }
  const built = { count, ids, packed }
  caches.set(db, built)
  return built
}

/**
 * Top-K nearest documents to `query` by Hamming distance.
 * @param {{ db, logger?, embedder? }} ctx
 * @param {string} query
 * @param {number} [topK]
 * @returns {Promise<Array<{ documentId: number, distance: number }>>}
 */
export async function semanticCandidates(ctx, query, topK = 50) {
  const { db, logger } = ctx
  if (!isSemanticAvailable(db)) return []
  const embedder = ctx.embedder ?? (await getEmbedder({ logger }))
  if (!embedder) return []
  const store = loadVectors(db)
  if (!store) return []

  const qv = quantize(await embedder.embed(query))
  const { ids, packed } = store
  const n = ids.length

  // Bounded selection of the K smallest distances (single pass, K-sorted).
  const idx = []
  const dist = []
  let worst = Infinity
  for (let i = 0; i < n; i++) {
    const d = hamming(qv, packed, i * VECTOR_BYTES)
    if (idx.length < topK) {
      insertSorted(idx, dist, i, d)
      worst = dist[dist.length - 1]
    } else if (d < worst) {
      idx.pop(); dist.pop()
      insertSorted(idx, dist, i, d)
      worst = dist[dist.length - 1]
    }
  }
  return idx.map((j, r) => ({ documentId: ids[j], distance: dist[r] }))
}

function insertSorted(idxArr, distArr, j, d) {
  let lo = 0
  let hi = distArr.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (distArr[m] <= d) lo = m + 1
    else hi = m
  }
  idxArr.splice(lo, 0, j)
  distArr.splice(lo, 0, d)
}

/** Test seam (no-op now that the cache is a per-DB WeakMap; kept for callers). */
export function _resetVectorCache() {}
