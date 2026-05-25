// SF Symbols snapshot meta helpers.
//
// Extracted from src/resources/apple-symbols/sync.js so the parent
// stays comfortably under the 400-line ceiling.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { symbolVariantKey, symbolVariantMatrix } from './cache-key.js'
import { SYMBOL_RENDERER_VERSION } from './render.js'

/**
 * Decide whether the pre-rendered SF Symbols snapshot under `baseDir`
 * needs to be wiped + re-built. Returns `true` when:
 *   - `meta.json` is missing.
 *   - The recorded renderer version no longer matches the current code.
 *   - The variant set for either scope (public/private) doesn't match
 *     what the matrix currently expects.
 *
 * Returns `false` when the directory is empty (clean install path —
 * the caller will populate it from scratch) or when everything looks
 * current.
 */
export async function symbolSnapshotNeedsReset(baseDir) {
  if (!existsSync(baseDir)) return false
  const entries = readdirSync(baseDir, { withFileTypes: true })
    .filter(entry => entry.name !== 'meta.json')
  if (entries.length === 0) return false

  const meta = await readJsonIfExists(join(baseDir, 'meta.json'))
  if (!meta || meta.rendererVersion !== SYMBOL_RENDERER_VERSION) return true
  return !hasSnapshotVariantSet(meta, 'public') || !hasSnapshotVariantSet(meta, 'private')
}

async function readJsonIfExists(path) {
  try {
    return await Bun.file(path).json()
  } catch {
    return null
  }
}

function hasSnapshotVariantSet(meta, scope) {
  const expected = symbolVariantMatrix(scope).map(symbolVariantKey).sort()
  const actual = Array.isArray(meta?.variants?.[scope])
    ? meta.variants[scope].map(symbolVariantKey).sort()
    : []
  return expected.length === actual.length && expected.every((key, index) => key === actual[index])
}
