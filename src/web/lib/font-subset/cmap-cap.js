import { readFile } from 'node:fs/promises'
import { parseCmap } from '../../../resources/apple-symbols/codepoint-from-font.js'

/**
 * Cap the requested codepoint set against the source font's representable
 * codepoints. Any codepoint outside the font's `cmap` is rejected so we
 * never ship a subset that silently omits glyphs the caller asked for.
 *
 * The legal codepoint set is parsed once per (family, fontPath) and
 * cached in-memory. The cache key folds the resolved path so a future
 * snapshot swap (which lands at a new path or invalidates this module)
 * isn't picked up by accident.
 */

const cache = new Map() // key: `${family}::${fontPath}` -> Set<number>

/**
 * Build (or fetch from cache) the legal codepoint set for one family.
 * @param {string} family
 * @param {string} fontPath
 * @returns {Promise<Set<number>>}
 */
export async function getLegalCodepointSet(family, fontPath) {
  const key = `${family}::${fontPath}`
  const hit = cache.get(key)
  if (hit) return hit
  const set = await loadLegalSet(fontPath)
  cache.set(key, set)
  return set
}

async function loadLegalSet(fontPath) {
  const buf = await readFile(fontPath)
  const tables = parseSfntDirectoryLocal(buf)
  const cmapRec = tables.get('cmap')
  if (!cmapRec) throw new Error(`font missing cmap table: ${fontPath}`)
  const cmapTable = buf.subarray(cmapRec.offset, cmapRec.offset + cmapRec.length)
  const map = parseCmap(cmapTable)
  return new Set(map.keys())
}

// Local SFNT-directory parser. Mirrors the helper inside
// codepoint-from-font.js but stays unexported there, so we duplicate the
// 10 lines here rather than widen that module's public surface.
function parseSfntDirectoryLocal(buf) {
  if (buf.length < 12) throw new Error('font too short for SFNT header')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const numTables = view.getUint16(4, false)
  const tables = new Map()
  for (let i = 0; i < numTables; i++) {
    const recOffset = 12 + i * 16
    const tag = String.fromCharCode(
      buf[recOffset], buf[recOffset + 1], buf[recOffset + 2], buf[recOffset + 3],
    )
    const offset = view.getUint32(recOffset + 8, false)
    const length = view.getUint32(recOffset + 12, false)
    tables.set(tag, { offset, length })
  }
  return tables
}

/**
 * @param {Set<number>} legal
 * @param {number[]} codepoints
 * @param {number} [maxIllegalSamples]
 * @returns {{ ok: boolean, illegal: number[], illegalCount: number }}
 */
export function capAgainst(legal, codepoints, maxIllegalSamples = 20) {
  const illegal = []
  let count = 0
  for (const cp of codepoints) {
    if (!legal.has(cp)) {
      count++
      if (illegal.length < maxIllegalSamples) illegal.push(cp)
    }
  }
  return { ok: count === 0, illegal, illegalCount: count }
}

/** Test-only hatch: drop the legal-set cache. */
export function _clearCmapCache() {
  cache.clear()
}
