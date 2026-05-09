/**
 * v15a — numeric companion columns for platform minimums.
 *
 * The original schema stored min_{ios,macos,watchos,tvos,visionos} as
 * TEXT and the search filter used `<=` for version comparisons. SQLite
 * compares TEXT lexicographically so `'10.0' < '9.0'` — a real query
 * regression that hid every iOS-10+ symbol when filtering by `iOS 9`.
 *
 * Rather than forklift the schema into an extension table (the plan's
 * preferred shape), this migration adds INTEGER companion columns next
 * to the existing TEXT columns and backfills them. Filter predicates
 * compare on the numeric column; the TEXT column stays for display +
 * legacy callers, and the INSERT path populates both. Smaller blast
 * radius, same correctness fix.
 *
 * Encoding: MAJOR * 1_000_000 + MINOR * 1_000 + PATCH. See
 * src/lib/version-encode.js — single source of truth shared by the
 * migration and the runtime writers.
 */
import { encodeVersion } from '../../lib/version-encode.js'

const PLATFORMS = ['ios', 'macos', 'watchos', 'tvos', 'visionos']

export function up(db) {
  for (const p of PLATFORMS) {
    const col = `min_${p}_num`
    try {
      db.run(`ALTER TABLE documents ADD COLUMN ${col} INTEGER`)
    } catch (e) {
      // Idempotent re-run: the column exists already from a partial
      // previous attempt. Any other error rethrows.
      if (!/duplicate column name/i.test(e.message ?? '')) throw e
    }
    db.run(`CREATE INDEX IF NOT EXISTS idx_documents_${col} ON documents(${col})`)
  }

  // Backfill. Read row-by-row in JS — the encoding logic is non-trivial
  // and SQLite has no native semver parser. The cost is one full-table
  // scan once, on a corpus that's already indexed.
  const rows = db.query(
    'SELECT id, min_ios, min_macos, min_watchos, min_tvos, min_visionos FROM documents',
  ).all()
  const updateStmt = db.query(`
    UPDATE documents SET
      min_ios_num = $ios,
      min_macos_num = $macos,
      min_watchos_num = $watchos,
      min_tvos_num = $tvos,
      min_visionos_num = $visionos
    WHERE id = $id
  `)
  for (const row of rows) {
    updateStmt.run({
      $id: row.id,
      $ios: encodeVersion(row.min_ios),
      $macos: encodeVersion(row.min_macos),
      $watchos: encodeVersion(row.min_watchos),
      $tvos: encodeVersion(row.min_tvos),
      $visionos: encodeVersion(row.min_visionos),
    })
  }
}
