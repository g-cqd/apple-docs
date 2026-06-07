import { ValidationError } from '../lib/errors.js'
import { encodeSectionContent } from '../storage/section-codec.js'
import { getProfile, setProfile } from '../storage/profiles.js'

// Contentless body FTS: stops storing a second full copy of every body.
// `contentless_delete=1` (SQLite ≥3.43) keeps the incremental sync
// delete-by-rowid path (`deleteBodyByDocId`) working without the old text.
const BODY_FTS_CONTENTLESS = `CREATE VIRTUAL TABLE documents_body_fts USING fts5(
  body, content='', contentless_delete=1, tokenize='porter unicode61'
)`

/**
 * Compact an install for minimum disk: zstd-compress document_sections content
 * in place, rebuild documents_body_fts as a contentless index (dropping its
 * stored body copy), and drop the embedded raw payloads (document_raw, ~1 GB on
 * a full corpus — `--keep-raw` retains them). Reads stay correct because every
 * section reader decodes via src/storage/section-codec.js; the profile switches
 * to render-on-demand.
 *
 * Refuses a `prebuilt` install (compaction trades disk for per-read
 * decompression — the opposite of the prebuilt fast path) unless --force.
 *
 * Idempotent: already-compressed rows and rows that don't shrink are left as-is.
 *
 * @param {{ force?: boolean, keepRaw?: boolean }} opts
 * @param {{ db, dataDir, logger }} ctx
 */
export async function storageCompact(opts, ctx) {
  const { db, dataDir, logger } = ctx
  const force = opts?.force ?? false

  if (!db.hasTable('document_sections')) {
    throw new ValidationError('Nothing to compact: this install has no document_sections.')
  }
  const profileBefore = getProfile(db)
  if (profileBefore === 'prebuilt' && !force) {
    throw new ValidationError(
      'Refusing to compact a `prebuilt` install — it would add per-read decompression on the fast path. ' +
      'Set a render-on-demand profile first (`apple-docs storage profile raw-only`) or pass --force.',
      { field: 'profile', value: profileBefore },
    )
  }

  // 1. Compress section content in place.
  logger?.info?.('Compacting document_sections…')
  const rows = db.db.query('SELECT id, content_text, content_json FROM document_sections').all()
  const update = db.db.query('UPDATE document_sections SET content_text = $t, content_json = $j WHERE id = $id')
  let compressed = 0
  db.db.run('BEGIN')
  try {
    for (const row of rows) {
      const tBlob = row.content_text != null && typeof row.content_text !== 'string'
      const jBlob = row.content_json != null && typeof row.content_json !== 'string'
      if (tBlob && jBlob) continue // already compacted
      const t = tBlob ? row.content_text : encodeSectionContent(row.content_text)
      const j = jBlob ? row.content_json : encodeSectionContent(row.content_json)
      update.run({ $t: t, $j: j, $id: row.id })
      compressed++
    }
    db.db.run('COMMIT')
  } catch (e) {
    db.db.run('ROLLBACK')
    throw e
  }

  // 2. Rebuild documents_body_fts as contentless so it stops storing a second
  //    copy of every body. (bun:sqlite re-prepares the repo's cached body
  //    statements after the drop+recreate.)
  if (db.hasTable('documents_body_fts')) {
    logger?.info?.('Rebuilding body index as contentless…')
    db.db.run('DROP TABLE documents_body_fts')
    db.db.run(BODY_FTS_CONTENTLESS)
    const { indexBodyFull } = await import('../pipeline/index-body.js')
    await indexBodyFull(db, dataDir, logger)
  }

  // 2b. Drop the embedded raw upstream payloads (document_raw). They exist
  //     only to re-materialize raw-json on demand; reads and search use
  //     document_sections, which stay intact. On a v23 corpus this is the
  //     single biggest compaction win (~1 GB). DELETE (not DROP) keeps the
  //     table so prepared statements / `storage materialize raw-json` still
  //     resolve — they just return nothing. `--keep-raw` retains them.
  let rawDropped = 0
  if (!opts?.keepRaw && db.hasTable('document_raw')) {
    rawDropped = db.db.query('SELECT COUNT(*) AS c FROM document_raw').get().c
    if (rawDropped > 0) {
      logger?.info?.(`Dropping ${rawDropped} embedded raw payloads (pass --keep-raw to retain)…`)
      db.db.run('DELETE FROM document_raw')
    }
  }

  // 3. Record the mode, switch to render-on-demand, reclaim freed pages.
  db.setSnapshotMeta('sections_compressed', '1')
  if (profileBefore !== 'raw-only') setProfile(db, 'raw-only')
  logger?.info?.('Reclaiming free pages (VACUUM)…')
  db.db.run('VACUUM')
  // VACUUM commits via the WAL; truncate it so the freed space is realized on
  // disk immediately instead of lingering as a multi-MB stale `-wal` file.
  db.db.run('PRAGMA wal_checkpoint(TRUNCATE)')

  const profile = getProfile(db)
  logger?.info?.(`Compact complete: ${compressed} sections compressed; ${rawDropped} raw payloads dropped; profile=${profile}.`)
  return { status: 'ok', sectionsCompressed: compressed, rawDropped, profile }
}
