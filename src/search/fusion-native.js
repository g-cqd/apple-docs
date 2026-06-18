/**
 * Fusion dispatch: native (libAppleDocsCore via bun:ffi) when the
 * `APPLE_DOCS_NATIVE` kill switch enables the `fusion` module, JS
 * (./fusion.js, the normative reference) otherwise — and on ANY doubt:
 * loader failure, native error status, or inputs outside the packed-codec
 * contract all fall back to JS for that call.
 *
 * Byte layouts are shared verbatim with swift/Sources/ADCore/FusionExports.swift.
 */
import { createLogger } from '../lib/logger.js'
import { getNativeLib, isNativeEnabled } from '../native/loader.js'
import { nativeErrorMessage, readNativeResult } from '../native/result.js'
import { hamming } from './embedding.js'
import { hybridFusion as jsHybridFusion, mmrSelect as jsMmrSelect, weightedRRF as jsWeightedRRF } from './fusion.js'

const MODULE = 'fusion'
let forced = null // 'js' | 'native' | null
let announced = false
let nativeCalls = 0
let logger

/** Test seams. */
export function _forceImpl(impl) {
  forced = impl
  announced = false
}
export function _nativeCallCount() {
  return nativeCalls
}

/** The production MMR similarity (fuse-semantic.js): 1 − hamming/bits. */
export function hammingSim(a, b) {
  const w = Math.min(a.length, b.length)
  return 1 - hamming(a, b, 0, w) / (w * 8)
}

function nativeLib() {
  if (forced === 'js') return null
  if (forced !== 'native' && !isNativeEnabled(MODULE)) return null
  const lib = getNativeLib()
  if (!announced) {
    logger ??= createLogger(process.env.APPLE_DOCS_LOG_LEVEL || 'info')
    logger.info(`fusion: served by ${lib ? 'native libAppleDocsCore' : 'js (native unavailable)'}`)
    announced = true
  }
  return lib
}

// Request packing reuses one grow-only scratch buffer: at production sizes
// (n≈10–100) allocation dominated the packing cost. Safe because calls are
// synchronous and single-threaded — the native side consumes the bytes
// before the call returns, and at most one packed request is live.
let scratch = new ArrayBuffer(4096)
let scratchU8 = new Uint8Array(scratch)
let scratchView = new DataView(scratch)

function ensureScratch(byteLength) {
  if (scratch.byteLength < byteLength) {
    let size = scratch.byteLength * 2
    while (size < byteLength) size *= 2
    scratch = new ArrayBuffer(size)
    scratchU8 = new Uint8Array(scratch)
    scratchView = new DataView(scratch)
  }
}

/**
 * Packs lists into the fusion request. Interning scans lists in order and
 * ranks in order, first-seen wins — reproducing the JS Maps' insertion
 * order, so the result Map is order-identical by construction. Returns
 * null when the inputs sit outside the codec contract (per-list scores not
 * aligned 1:1 with ranked) — the caller then uses the JS implementation.
 */
function packFusion(lists, k, beta, useScores) {
  const ids = []
  const indexOf = new Map()
  for (const { ranked } of lists) {
    for (const key of ranked) {
      if (!indexOf.has(key)) {
        indexOf.set(key, ids.length)
        ids.push(key)
      }
    }
  }
  let rankedTotal = 0
  for (const list of lists) {
    rankedTotal += list.ranked.length
    if (!useScores || !list.scores) continue
    if (!(list.scores instanceof Map) || list.scores.size !== list.ranked.length) return null
    for (const key of list.ranked) if (!list.scores.has(key)) return null
  }

  const metaOffset = 24
  const rankedOffset = metaOffset + 16 * lists.length
  const scoresOffset = rankedOffset + 4 * rankedTotal + ((8 - ((rankedOffset + 4 * rankedTotal) % 8)) % 8)
  let scoreCount = 0
  if (useScores) for (const list of lists) if (list.scores) scoreCount += list.ranked.length
  const totalBytes = scoresOffset + 8 * scoreCount
  ensureScratch(totalBytes)
  const view = scratchView

  view.setUint32(0, lists.length, true)
  view.setUint32(4, ids.length, true)
  view.setFloat64(8, k, true)
  view.setFloat64(16, beta, true)
  let meta = metaOffset
  let ranked = rankedOffset
  let scores = scoresOffset
  for (const list of lists) {
    const hasScores = useScores && list.scores ? 1 : 0
    view.setUint32(meta, list.ranked.length, true)
    view.setUint32(meta + 4, hasScores, true)
    view.setFloat64(meta + 8, list.weight, true)
    meta += 16
    for (const key of list.ranked) {
      view.setUint32(ranked, indexOf.get(key), true)
      ranked += 4
    }
    if (hasScores) {
      for (const key of list.ranked) {
        view.setFloat64(scores, list.scores.get(key), true)
        scores += 8
      }
    }
  }
  // Pad bytes between ranked and scores stay dirty — the decoder skips them
  // without reading (RequestReader.align8).
  return { request: scratchU8.subarray(0, totalBytes), ids }
}

function callFusion(lib, symbol, packed) {
  const result = readNativeResult(lib, symbol(packed.request, packed.request.length))
  if (result.status !== 0) {
    logger ??= createLogger(process.env.APPLE_DOCS_LOG_LEVEL || 'info')
    logger.warn(`fusion: native returned status ${result.status} (${nativeErrorMessage(result)}) — js fallback`)
    return null
  }
  nativeCalls++
  const out = new Float64Array(result.bytes.buffer, 0, packed.ids.length)
  const map = new Map()
  for (let i = 0; i < packed.ids.length; i++) map.set(packed.ids[i], out[i])
  return map
}

/** @see fusion.js weightedRRF — identical contract. */
export function weightedRRF(lists, opts = {}) {
  const lib = nativeLib()
  if (lib) {
    // rrf never reads scores (JS semantics) — pack without them.
    const packed = packFusion(lists, opts.k ?? 60, 0, false)
    if (packed) {
      const map = callFusion(lib, lib.symbols.ad_fusion_rrf, packed)
      if (map) return map
    }
  }
  return jsWeightedRRF(lists, opts)
}

/** @see fusion.js hybridFusion — identical contract. */
export function hybridFusion(lists, opts = {}) {
  const lib = nativeLib()
  if (lib) {
    const packed = packFusion(lists, opts.k ?? 60, opts.beta ?? 0.5, true)
    if (packed) {
      const map = callFusion(lib, lib.symbols.ad_fusion_hybrid, packed)
      if (map) return map
    }
  }
  return jsHybridFusion(lists, opts)
}

function packMmr(ranked, vecOf, lambda, limit) {
  const n = ranked.length
  const vecs = []
  let dim = -1
  for (const item of ranked) {
    const vec = vecOf(item)
    if (vec != null) {
      if (!(vec instanceof Uint8Array)) return null
      if (dim === -1) dim = vec.length
      else if (vec.length !== dim) return null
    }
    vecs.push(vec ?? null)
  }
  if (dim === -1) dim = 0
  const bitmapBytes = (n + 7) >> 3
  const rowsOffset = 24 + bitmapBytes
  const totalBytes = rowsOffset + n * dim
  ensureScratch(totalBytes)
  const view = scratchView
  view.setUint32(0, n, true)
  view.setUint32(4, dim, true)
  view.setFloat64(8, lambda, true)
  view.setUint32(16, limit, true)
  view.setUint32(20, 0, true)
  // The bitmap is built with |=, so its region must start zeroed; rows of
  // absent vectors stay arbitrary by contract (the decoder never reads them).
  scratchU8.fill(0, 24, rowsOffset)
  for (let i = 0; i < n; i++) {
    const vec = vecs[i]
    if (!vec) continue
    scratchU8[24 + (i >> 3)] |= 1 << (i & 7)
    scratchU8.set(vec, rowsOffset + i * dim)
  }
  return scratchU8.subarray(0, totalBytes)
}

/**
 * @see fusion.js mmrSelect — identical contract. Native only for the
 * production shape: the tagged `hammingSim`, uniform Uint8Array vectors,
 * and `limit` either absent or ≥ 1; anything else runs the JS reference.
 */
export function mmrSelect(ranked, vecOf, sim, opts = {}) {
  const { lambda = 0.7, limit } = opts
  if (ranked.length > 2 && sim === hammingSim && (limit === undefined || limit >= 1)) {
    const lib = nativeLib()
    if (lib) {
      const request = packMmr(ranked, vecOf, lambda, limit === undefined ? 0 : limit)
      if (request) {
        const result = readNativeResult(lib, lib.symbols.ad_fusion_mmr(request, request.length))
        if (result.status === 0) {
          nativeCalls++
          const order = new Uint32Array(result.bytes.buffer, 0, ranked.length)
          const out = new Array(ranked.length)
          for (let i = 0; i < ranked.length; i++) out[i] = ranked[order[i]]
          return out
        }
        logger ??= createLogger(process.env.APPLE_DOCS_LOG_LEVEL || 'info')
        logger.warn(`fusion: native mmr returned status ${result.status} (${nativeErrorMessage(result)}) — js fallback`)
      }
    }
  }
  return jsMmrSelect(ranked, vecOf, sim, opts)
}
