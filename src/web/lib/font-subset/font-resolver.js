import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Map a public `font` family id (as used by the /api/fonts/subset request
 * body) to the absolute path of its variable master `.ttf`/`.otf` on disk.
 * Returns `null` when the family has no single master suitable for
 * subsetting — the caller responds with 400 in that case.
 *
 * Subsetting is only meaningful against the family's variable master:
 * a static cut (e.g. SF-Pro-Display-Bold.otf) is already weight-locked and
 * users who want a thinned version of *one* style should subset the master
 * and pin axes downstream. For families without a variable master
 * (sf-mono ships only static cuts) we return null.
 *
 * Filenames follow the conventions observed under
 * `<dataDir>/resources/fonts/extracted/<family>/`:
 *
 *   sf-pro       → SF-Pro.ttf
 *   sf-compact   → SF-Compact.ttf
 *   new-york     → NewYork.ttf
 *   sf-arabic    → SF-Arabic.ttf
 *   sf-armenian  → SF-Armenian.ttf
 *   sf-georgian  → SF-Georgian.ttf
 *   sf-hebrew    → SF-Hebrew.ttf
 *
 * sf-mono and any other family return null.
 */

const FAMILY_MASTER_FILENAMES = Object.freeze({
  'sf-pro': 'SF-Pro.ttf',
  'sf-compact': 'SF-Compact.ttf',
  'new-york': 'NewYork.ttf',
  'sf-arabic': 'SF-Arabic.ttf',
  'sf-armenian': 'SF-Armenian.ttf',
  'sf-georgian': 'SF-Georgian.ttf',
  'sf-hebrew': 'SF-Hebrew.ttf',
})

/**
 * @param {string} family
 * @param {string} dataDir
 * @returns {string | null}
 */
export function resolveFontPath(family, dataDir) {
  if (!family || typeof family !== 'string') return null
  if (!dataDir || typeof dataDir !== 'string') return null
  const filename = FAMILY_MASTER_FILENAMES[family]
  if (!filename) return null
  const path = join(dataDir, 'resources', 'fonts', 'extracted', family, filename)
  if (!existsSync(path)) return null
  return path
}

// Kept around for the upcoming P4 /design Generator pane which needs the
// list of subsettable families to drive the font picker. Not exported
// until that consumer lands — knip's "unused exports" gate would
// otherwise flag it. Re-export when wiring the Generator UI.
// function listSupportedFamilies() { return Object.keys(FAMILY_MASTER_FILENAMES) }
