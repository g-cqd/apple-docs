/**
 * Optional semantic-search tier.
 *
 * Two read paths, chosen by what the snapshot ships:
 *   - **chunk** (`document_chunks` populated): the SOTA "binary-retrieve →
 *     int8-rescore" pipeline. A full Hamming scan over the resident binary
 *     codes shortlists the top-N chunks; each shortlisted chunk's int8 code is
 *     pulled on demand and rescored with a full-precision query dot product;
 *     scores are then max-pooled to documents. Only the small binary codes stay
 *     resident, so RAM stays near the legacy footprint.
 *   - **legacy** (`document_vectors` only — old snapshots): a single whole-doc
 *     binary code per document, Hamming-scanned as before. Zero behavior change.
 *
 * Dormant unless vectors/chunks are populated AND a query embedder is available
 * AND `APPLE_DOCS_SEMANTIC !== 'off'`. When dormant, callers fall back to
 * lexical-only search (zero behavior change).
 */

import { join } from 'node:path'
import { quantize, quantizeTo, hamming, dotI8, VECTOR_DIMS, VECTOR_BYTES } from './embedding.js'
import { getEmbedder } from './embedder.js'

// Per-DB packed vector store (WeakMap → no cross-instance collision, auto-GC).
// Invalidated cheaply by row count + mode.
const caches = new WeakMap()

/** Cheap gate: vectors or chunks present and not explicitly disabled. */
export function isSemanticAvailable(db) {
  if (process.env.APPLE_DOCS_SEMANTIC === 'off') return false
  if (typeof db?.getVectorCount !== 'function') return false
  if (db.getVectorCount() > 0) return true
  return typeof db.getChunkCount === 'function' && db.getChunkCount() > 0
}

/** Resolve the embedding width the snapshot was built at (meta, else infer). */
function readDims(db, fallback) {
  const meta = typeof db.getSnapshotMeta === 'function' ? db.getSnapshotMeta('embed_dims') : null
  const n = meta ? Number.parseInt(meta, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function loadVectors(db) {
  const chunkCount = typeof db.getChunkCount === 'function' ? db.getChunkCount() : 0
  if (chunkCount > 0) return resolveStore(db, 'chunk', chunkCount, () => buildChunkStore(db, chunkCount))
  const vectorCount = db.getVectorCount()
  if (vectorCount === 0) { caches.delete(db); return null }
  return resolveStore(db, 'legacy', vectorCount, () => buildLegacyStore(db, vectorCount))
}

/** Cache + return a store; a built store carries `usable` so a degraded
 *  snapshot caches its verdict instead of rebuilding every query. */
function resolveStore(db, mode, count, build) {
  const existing = caches.get(db)
  if (existing && existing.mode === mode && existing.count === count) return existing.usable ? existing : null
  const store = build()
  caches.set(db, store)
  return store.usable ? store : null
}

/** Legacy whole-doc store: one binary code per document. */
function buildLegacyStore(db, count) {
  const rows = db.getAllVectors()
  // Keep only codes whose width matches the live size — an older snapshot
  // (48-byte MiniLM) read by the 64-byte reader is a mismatch; skipping those
  // degrades to lexical-only instead of Hamming-scanning misaligned bytes.
  const usable = rows.filter(r => r.vec && r.vec.length === VECTOR_BYTES)
  if (usable.length === 0) return { mode: 'legacy', count, usable: false }
  const ids = new Int32Array(usable.length)
  const packed = new Uint8Array(usable.length * VECTOR_BYTES)
  for (let i = 0; i < usable.length; i++) {
    ids[i] = usable[i].document_id
    packed.set(usable[i].vec, i * VECTOR_BYTES)
  }
  return { mode: 'legacy', count, usable: true, n: usable.length, width: VECTOR_BYTES, dims: VECTOR_DIMS, ids, packed }
}

/** Chunk store: resident binary codes + chunk→doc map (int8 fetched on demand). */
function buildChunkStore(db, count) {
  const rows = db.getAllChunkVectors()
  const sample = rows.find(r => r.vec_bin)
  if (!sample) return { mode: 'chunk', count, usable: false }
  const dims = readDims(db, sample.vec_bin.length * 8)
  const binWidth = Math.ceil(dims / 8)
  const usable = rows.filter(r => r.vec_bin && r.vec_bin.length === binWidth)
  if (usable.length === 0) return { mode: 'chunk', count, usable: false }
  const n = usable.length
  const binPacked = new Uint8Array(n * binWidth)
  const chunkDocId = new Int32Array(n)
  const chunkId = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const r = usable[i]
    binPacked.set(r.vec_bin, i * binWidth)
    chunkDocId[i] = r.document_id
    chunkId[i] = r.chunk_id
  }
  return { mode: 'chunk', count, usable: true, n, dims, binWidth, binPacked, chunkDocId, chunkId }
}

/**
 * Top-K nearest documents to `query`.
 * @param {{ db, dataDir?, logger?, embedder? }} ctx
 * @param {string} query
 * @param {number} [topK]
 * @returns {Promise<Array<{ documentId: number, distance: number, score: number, vec: Uint8Array }>>}
 */
export async function semanticCandidates(ctx, query, topK = 50) {
  const { db, dataDir, logger } = ctx
  if (!isSemanticAvailable(db)) return []
  const modelsDir = dataDir ? join(dataDir, 'resources', 'models') : undefined
  const embedder = ctx.embedder ?? (await getEmbedder({ logger, modelsDir }))
  if (!embedder) return []
  const store = loadVectors(db)
  if (!store) return []

  const qFp32 = await embedder.embed(query)
  // Width guard (generalizes the v22 code-size check to the query side): a
  // query embedded at a different width than the snapshot can't be compared —
  // degrade to lexical-only rather than scan misaligned codes.
  if (qFp32.length !== store.dims) {
    logger?.debug?.(`semantic tier dims mismatch (query ${qFp32.length} vs index ${store.dims}) — lexical-only`)
    return []
  }
  return store.mode === 'chunk'
    ? chunkSearch(db, store, qFp32, topK, logger)
    : legacySearch(store, qFp32, topK)
}

/** Legacy path: Hamming top-K over whole-doc codes. */
function legacySearch(store, qFp32, topK) {
  const qBin = quantize(qFp32)
  const bits = store.width * 8
  const shortlist = shortlistByHamming(qBin, store.packed, store.width, store.n, topK)
  return shortlist.map(({ idx, dist }) => ({
    documentId: store.ids[idx],
    distance: dist,
    score: 1 - dist / bits,
    vec: store.packed.subarray(idx * store.width, idx * store.width + store.width),
  }))
}

/** Chunk path: Hamming shortlist → int8 rescore → max-sim pool to documents. */
function chunkSearch(db, store, qFp32, topK, logger) {
  const qBin = quantizeTo(qFp32, store.dims)
  const bits = store.binWidth * 8
  const shortlistN = clampInt(process.env.APPLE_DOCS_SEMANTIC_SHORTLIST, 200, 16, 5000)
  const shortlist = shortlistByHamming(qBin, store.binPacked, store.binWidth, store.n, shortlistN)
  const rescore = process.env.APPLE_DOCS_RESCORE !== 'off'

  // Max-pool chunk scores up to their documents; keep each doc's best chunk
  // (its code becomes the doc's vector for the MMR diversity pass downstream).
  const docBest = new Map()
  for (const { idx, dist } of shortlist) {
    let score = 1 - dist / bits
    if (rescore) {
      const i8 = db.getChunkI8(store.chunkId[idx])
      if (i8 && i8.length === store.dims + 4) score = dotI8(qFp32, i8, 0, store.dims)
    }
    const docId = store.chunkDocId[idx]
    const prev = docBest.get(docId)
    if (!prev || score > prev.score) docBest.set(docId, { score, distance: dist, idx })
  }
  const out = []
  for (const [documentId, v] of docBest) {
    out.push({
      documentId,
      distance: v.distance,
      score: v.score,
      vec: store.binPacked.subarray(v.idx * store.binWidth, v.idx * store.binWidth + store.binWidth),
    })
  }
  out.sort((a, b) => b.score - a.score)
  if (out.length === 0) logger?.debug?.('semantic chunk shortlist empty')
  return out.slice(0, topK)
}

/** Bounded selection of the K smallest Hamming distances (single pass). */
function shortlistByHamming(qBin, packed, width, n, K) {
  const idx = []
  const dist = []
  let worst = Infinity
  for (let i = 0; i < n; i++) {
    const d = hamming(qBin, packed, i * width, width)
    if (idx.length < K) {
      insertSorted(idx, dist, i, d)
      worst = dist[dist.length - 1]
    } else if (d < worst) {
      idx.pop(); dist.pop()
      insertSorted(idx, dist, i, d)
      worst = dist[dist.length - 1]
    }
  }
  return idx.map((j, r) => ({ idx: j, dist: dist[r] }))
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

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Test seam (no-op now that the cache is a per-DB WeakMap; kept for callers). */
export function _resetVectorCache() {}
