/**
 * Migration runner. Walks the linear MIGRATIONS list in version order,
 * applying every migration whose version is greater than the current
 * schema_meta row. The full pass runs inside a single BEGIN/COMMIT so a
 * failure mid-flight rolls back to the original schema_version.
 *
 * Each migration module exports `up(db)` and is responsible for being
 * idempotent against partial state (most existing migrations guard
 * ALTER TABLE in try/catch for re-run safety).
 */

import { up as v1Up } from './v1-initial-schema.js'
import { up as v2Up } from './v2-activity-table.js'
import { up as v3Up } from './v3-roots-seed-path.js'
import { up as v4Up } from './v4-fts-trigram.js'
import { up as v5Up } from './v5-multi-source-metadata.js'
import { up as v6Up } from './v6-documents-table.js'
import { up as v7Up } from './v7-source-type-backfill.js'
import { up as v8Up } from './v8-sync-checkpoint.js'
import { up as v9Up } from './v9-document-render-index.js'
import { up as v10Up } from './v10-fonts-symbols-tables.js'
import { up as v11Up } from './v11-symbols-fts-rebuild.js'
import { up as v12Up } from './v12-fonts-classification.js'
import { up as v13Up } from './v13-documents-title-index.js'
import { up as v14Up } from './v14-trigram-external-content.js'
import { up as v15Up } from './v15-kill-refs.js'

export const MIGRATIONS = Object.freeze([
  { version: 1, up: v1Up },
  { version: 2, up: v2Up },
  { version: 3, up: v3Up },
  { version: 4, up: v4Up },
  { version: 5, up: v5Up },
  { version: 6, up: v6Up },
  { version: 7, up: v7Up },
  { version: 8, up: v8Up },
  { version: 9, up: v9Up },
  { version: 10, up: v10Up },
  { version: 11, up: v11Up },
  { version: 12, up: v12Up },
  { version: 13, up: v13Up },
  { version: 14, up: v14Up },
  { version: 15, up: v15Up },
])

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/**
 * Run any pending migrations on `db`. Idempotent — a current DB returns
 * without writing anything. Throws on a future-version DB (downgrade
 * protection) or any migration failure (transaction rolls back).
 */
export function runMigrations(db) {
  db.run('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = db.query('SELECT value FROM schema_meta WHERE key = ?').get('schema_version')
  const current = row ? Number.parseInt(row.value, 10) : 0

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than supported version ${SCHEMA_VERSION}. Update apple-docs to a newer version.`
    )
  }
  if (current === SCHEMA_VERSION) return

  db.run('BEGIN')
  try {
    for (const { version, up } of MIGRATIONS) {
      if (current < version) up(db)
    }
    db.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)])
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw new Error(`Migration from v${current} to v${SCHEMA_VERSION} failed: ${e.message}`)
  }
}
