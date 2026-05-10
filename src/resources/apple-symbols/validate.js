/**
 * Snapshot pre-render completeness gate.
 *
 * Snapshots are the supported acquisition path for SF Symbols on hosts
 * without the macOS system bundle. Shipping a snapshot whose
 * `resources/symbols/` is partial would silently 404 every missing
 * (name × weight × scale) combination at the consumer side. This
 * validator is the pre-tar gate that refuses to build an incomplete
 * snapshot, with an `--allow-incomplete-symbols` escape hatch for
 * deliberate partial builds (e.g., a Linux contributor who can't run
 * the live renderer).
 */

import { existsSync } from 'node:fs'
import { getPrerenderedSymbolPath, symbolVariantMatrix } from './cache-key.js'

/**
 * Walk the catalog × variant matrix and report any missing on-disk
 * pre-renders. The DB catalog is the source of truth; if a row is in
 * `sf_symbols`, the snapshot must carry every variant of that name.
 *
 * @param {{ db: object, dataDir: string }} ctx
 * @param {{ maxMissingSamples?: number }} [opts]
 * @returns {{ complete: boolean, missingCount: number, missing: string[],
 *   counts: { public: number, private: number } }}
 */
export function validateSymbolMatrixComplete(ctx, opts = {}) {
  const maxSamples = Math.max(1, opts.maxMissingSamples ?? 50)
  const symbols = ctx.db?.listSfSymbolsCatalog?.() ?? []
  const counts = { public: 0, private: 0 }
  const skippedBitmapOnly = { public: 0, private: 0 }
  const missing = []
  let missingCount = 0

  for (const symbol of symbols) {
    const scope = symbol.scope === 'private' ? 'private' : 'public'
    counts[scope]++
    // v18: bitmap-only symbols (emoji.* and a few private misc names)
    // genuinely don't have a vector form. Skip the file-existence
    // check so the snapshot completeness gate doesn't flag them.
    if (symbol.bitmapOnly) {
      skippedBitmapOnly[scope]++
      continue
    }
    for (const variant of symbolVariantMatrix(scope)) {
      const path = getPrerenderedSymbolPath(ctx, scope, symbol.name, variant)
      if (existsSync(path)) continue
      missingCount++
      if (missing.length < maxSamples) {
        missing.push(`${scope}/${symbol.name} (${variant.weight}/${variant.scale})`)
      }
    }
  }

  return { complete: missingCount === 0, missingCount, missing, counts, skippedBitmapOnly }
}
