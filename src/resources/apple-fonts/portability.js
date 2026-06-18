/**
 * Pre-publish invariant: a snapshot's font catalog must be self-contained.
 *
 * `apple_font_files.file_path` rows come from two sources (apple-assets.js):
 * DMG extraction under `<dataDir>/resources/fonts/extracted/` (portable —
 * the archive ships the files and `setup` re-indexes them on the consumer)
 * and the build host's system font dirs (`/Library/Fonts`, …) — dead paths
 * on every other machine. beta.1/beta.2 shipped ONLY system rows and the
 * public instance served an empty font catalog; a stdout-decode bug in the
 * DMG mount (sync.js runCapture) let CI ship the same silently.
 *
 * Called by both publish pipelines (scripts/build-snapshot.js and
 * scripts/publish-beta-snapshot.mjs): purges non-portable rows, then
 * reports any family left without an on-disk in-corpus file so the caller
 * can refuse to publish.
 */

import { existsSync } from 'node:fs'

/**
 * @param {import('../../storage/database.js').DocsDatabase} db
 * @param {string} dataDir
 * @param {{ logger?: object }} [opts]
 * @returns {{ total: number, purged: number, kept: number, families: number, missing: string[] }}
 */
export function enforceFontPortability(db, dataDir, { logger } = {}) {
  const prefix = `${dataDir}/`
  const rows = db.db.query('SELECT id, family_id, file_path FROM apple_font_files').all()
  const foreign = rows.filter((r) => !r.file_path.startsWith(prefix))
  if (foreign.length > 0) {
    logger?.warn?.(`Fonts: purging ${foreign.length} non-portable row(s) (outside ${dataDir})`)
    const del = db.db.query('DELETE FROM apple_font_files WHERE id = ?')
    for (const r of foreign) del.run(r.id)
  }
  const families = db.db.query('SELECT id FROM apple_font_families').all()
  const portable = rows.filter((r) => r.file_path.startsWith(prefix) && existsSync(r.file_path))
  const missing = families.map((f) => f.id).filter((id) => !portable.some((r) => r.family_id === id))
  return {
    total: rows.length,
    purged: foreign.length,
    kept: rows.length - foreign.length,
    families: families.length,
    missing,
  }
}
