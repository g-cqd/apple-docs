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
import { getEmbedder } from './embedder.js'
import { dotI8, hamming, hammingU32, quantize, quantizeTo, VECTOR_BYTES, VECTOR_DIMS } from './embedding.js'

// Per-DB packed vector store (WeakMap → no cross-instance collision, auto-GC).
// Invalidated cheaply by row count + mode; fully dropped by _resetVectorCache.
let caches = new WeakMap()

/** Cheap gate: vectors or chunks present and not explicitly disabled. @param {any} db */
export function isSemanticAvailable(db) {
  if (process.env.APPLE_DOCS_SEMANTIC === 'off') return false
  if (typeof db?.getVectorCount !== 'function') return false
  if (db.getVectorCount() > 0) return true
  return typeof db.getChunkCount === 'function' && db.getChunkCount() > 0
}

/** Resolve the embedding width the snapshot was built at (meta, else infer). @param {any} db @param {number} fallback */
function readDims(db, fallback) {
  const meta = typeof db.getSnapshotMeta === 'function' ? db.getSnapshotMeta('embed_dims') : null
  const n = meta ? Number.parseInt(meta, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** @param {any} db */
function loadVectors(db) {
  const chunkCount = typeof db.getChunkCount === 'function' ? db.getChunkCount() : 0
  if (chunkCount > 0) return resolveStore(db, 'chunk', chunkCount, () => buildChunkStore(db, chunkCount))
  const vectorCount = db.getVectorCount()
  if (vectorCount === 0) {
    caches.delete(db)
    return null
  }
  return resolveStore(db, 'legacy', vectorCount, () => buildLegacyStore(db, vectorCount))
}

/** Cache + return a store; a built store carries `usable` so a degraded
 *  snapshot caches its verdict instead of rebuilding every query.
 *  @param {any} db @param {string} mode @param {number} count @param {() => any} build */
function resolveStore(db, mode, count, build) {
  const existing = caches.get(db)
  if (existing && existing.mode === mode && existing.count === count) return existing.usable ? existing : null
  const store = build()
  caches.set(db, store)
  return store.usable ? store : null
}

/** Legacy whole-doc store: one binary code per document. @param {any} db @param {number} count */
function buildLegacyStore(db, count) {
  const rows = db.getAllVectors()
  // Keep only codes whose width matches the live size — an older snapshot
  // (48-byte MiniLM) read by the 64-byte reader is a mismatch; skipping those
  // degrades to lexical-only instead of Hamming-scanning misaligned bytes.
  const usable = rows.filter((/** @type {any} */ r) => r.vec && r.vec.length === VECTOR_BYTES)
  if (usable.length === 0) return { mode: 'legacy', count, usable: false }
  const ids = new Int32Array(usable.length)
  const packed = new Uint8Array(usable.length * VECTOR_BYTES)
  for (let i = 0; i < usable.length; i++) {
    ids[i] = usable[i].document_id
    packed.set(usable[i].vec, i * VECTOR_BYTES)
  }
  return { mode: 'legacy', count, usable: true, n: usable.length, width: VECTOR_BYTES, dims: VECTOR_DIMS, ids, packed }
}

/** Chunk store: resident binary codes + chunk→doc map (int8 fetched on demand). @param {any} db @param {number} count */
function buildChunkStore(db, count) {
  const rows = db.getAllChunkVectors()
  const sample = rows.find((/** @type {any} */ r) => r.vec_bin)
  if (!sample) return { mode: 'chunk', count, usable: false }
  const dims = readDims(db, sample.vec_bin.length * 8)
  const binWidth = Math.ceil(dims / 8)
  const usable = rows.filter((/** @type {any} */ r) => r.vec_bin && r.vec_bin.length === binWidth)
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
 * @param {{ db: any, dataDir?: string, logger?: any, embedder?: any }} ctx
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

  // Behavior-version drift (RFC 0001 §10): still serve — v1↔v2 deltas are
  // confined to astral-CJK inputs (measured: 0/2000 corpus chunks) — but say
  // so once per store; the next `index embeddings` run self-heals.
  if (embedder.embedVersion !== undefined && !store.versionChecked) {
    store.versionChecked = true
    const stored = (typeof db.getSnapshotMeta === 'function' && db.getSnapshotMeta('embed_version')) || '1'
    if (stored !== String(embedder.embedVersion)) {
      logger?.info?.(`semantic index was embedded at behavior v${stored}, live embedder is v${embedder.embedVersion} — serving; re-index to upgrade`)
    }
  }

  // isQuery selects the query-side instruction prefix on asymmetric models
  // (potion ignores it) — without it queries embed in document space.
  const qFp32 = await embedder.embed(query, { isQuery: true })
  // Width guard (generalizes the v22 code-size check to the query side): a
  // query embedded at a different width than the snapshot can't be compared —
  // degrade to lexical-only rather than scan misaligned codes.
  if (qFp32.length !== store.dims) {
    logger?.debug?.(`semantic tier dims mismatch (query ${qFp32.length} vs index ${store.dims}) — lexical-only`)
    return []
  }
  return store.mode === 'chunk' ? chunkSearch(db, store, qFp32, topK, logger) : legacySearch(store, qFp32, topK)
}

/** Legacy path: Hamming top-K over whole-doc codes. @param {any} store @param {Float32Array} qFp32 @param {number} topK */
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

/** Chunk path: Hamming shortlist → int8 rescore → max-sim pool to documents.
 * @param {any} db @param {any} store @param {Float32Array} qFp32 @param {number} topK @param {any} logger */
function chunkSearch(db, store, qFp32, topK, logger) {
  const qBin = quantizeTo(qFp32, store.dims)
  const bits = store.binWidth * 8
  const shortlistN = clampInt(process.env.APPLE_DOCS_SEMANTIC_SHORTLIST, 200, 16, 5000)
  const shortlist = shortlistByHamming(qBin, store.binPacked, store.binWidth, store.n, shortlistN)
  const rescore = process.env.APPLE_DOCS_RESCORE !== 'off'
  const i8Map = rescore ? db.getChunkI8Batch(shortlist.map(({ idx }) => store.chunkId[idx])) : null

  // Max-pool chunk scores up to their documents; keep each doc's best chunk
  // (its code becomes the doc's vector for the MMR diversity pass downstream).
  const docBest = new Map()
  for (const { idx, dist } of shortlist) {
    let score = 1 - dist / bits
    if (i8Map) {
      const i8 = i8Map.get(store.chunkId[idx])
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

/**
 * Bounded selection of the K smallest Hamming distances (single pass).
 *
 * A fixed-size binary max-heap keyed by (dist, idx) — the root is the
 * "worst" kept candidate (largest distance; ties broken by largest index).
 * This replaces an O(K)-splice insertion sort that measured at ~94% of
 * search self-time at K=200 over the 831k-code store (RFC 0001 §10 slice 1
 * — the popcount the lever was assumed to be is only ~3%). Output-identical
 * to the splice version:
 *   - admit iff `d < root distance` (strict — matches the old `d < worst`);
 *   - evict the (max dist, max idx) element (matches popping the sorted tail);
 *   - return sorted ascending by (dist, idx) (matches the old `<=` insert
 *     order + ascending scan).
 */
/** @param {any} qBin @param {Uint8Array} packed @param {number} width @param {number} n @param {number} K */
function shortlistByHamming(qBin, packed, width, n, K) {
  const heapDist = new Int32Array(K)
  const heapIdx = new Int32Array(K)
  let size = 0
  // SWAR popcount over 32-bit words when the code width is word-aligned
  // (all current widths are; the store is a fresh packed Uint8Array at
  // byteOffset 0). Views built once; the byte-LUT path is the fallback.
  const words = width >> 2
  const swar = (width & 3) === 0 && (packed.byteOffset & 3) === 0 && (qBin.byteOffset & 3) === 0
  const pW = swar ? new Uint32Array(packed.buffer, packed.byteOffset, n * words) : null
  const qW = swar ? new Uint32Array(qBin.buffer, qBin.byteOffset, words) : null
  for (let i = 0; i < n; i++) {
    const d = swar ? hammingU32(/** @type {Uint32Array} */ (qW), /** @type {Uint32Array} */ (pW), i * words, words) : hamming(qBin, packed, i * width, width)
    if (size < K) {
      // sift up: bubble (d, i) toward the root while parents are smaller.
      let c = size++
      while (c > 0) {
        const p = (c - 1) >> 1
        if (heapDist[p] > d || (heapDist[p] === d && heapIdx[p] > i)) break
        heapDist[c] = heapDist[p]
        heapIdx[c] = heapIdx[p]
        c = p
      }
      heapDist[c] = d
      heapIdx[c] = i
    } else if (d < heapDist[0]) {
      // replace the root, then sift down by (dist, idx).
      let c = 0
      for (;;) {
        const l = 2 * c + 1
        const r = l + 1
        let bigDist = d
        let bigIdx = i
        let big = -1
        if (l < K && (heapDist[l] > bigDist || (heapDist[l] === bigDist && heapIdx[l] > bigIdx))) {
          big = l
          bigDist = heapDist[l]
          bigIdx = heapIdx[l]
        }
        if (r < K && (heapDist[r] > bigDist || (heapDist[r] === bigDist && heapIdx[r] > bigIdx))) {
          big = r
        }
        if (big === -1) break
        heapDist[c] = heapDist[big]
        heapIdx[c] = heapIdx[big]
        c = big
      }
      heapDist[c] = d
      heapIdx[c] = i
    }
  }
  const out = new Array(size)
  for (let r = 0; r < size; r++) out[r] = { idx: heapIdx[r], dist: heapDist[r] }
  out.sort((a, b) => a.dist - b.dist || a.idx - b.idx)
  return out
}

/** @param {any} value @param {number} fallback @param {number} min @param {number} max */
function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Drop every cached store — call after a re-index or model switch so the
 *  next query rebuilds from the live tables. */
export function _resetVectorCache() {
  caches = new WeakMap()
}

/** Test seam: the bounded Hamming top-K selection (RFC 0001 §10 slice 1). */
export const _test = { shortlistByHamming }
