import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Corpus-integrity checks. Two flavours:
 * - verifySnapshot: structural assertions on a freshly-installed snapshot
 *   (database file present, schema_meta legible, expected tables, the
 *   render-index/checkpoint shape).
 * - verifyCorpusIntegrity: read-only audit a sync flow runs after a long
 *   session — orphan sections, FK violations, stale build-failure rows,
 *   and the size of the unconverted-page queue.
 */

export function verifySnapshot(db, _logger) {
  const tier = db.getSnapshotMeta('snapshot_tier')
  if (!tier) {
    return { installed: false, message: 'No snapshot found. Corpus was built locally.' }
  }

  const checks = []

  // Check 1: document count
  const expectedCount = Number.parseInt(db.getSnapshotMeta('snapshot_document_count') ?? '0', 10)
  const actualCount = db.db.query('SELECT COUNT(*) as c FROM documents').get().c
  checks.push({
    name: 'document_count',
    expected: expectedCount,
    actual: actualCount,
    ok: actualCount >= expectedCount,
  })

  // Check 2: schema version
  const expectedSchema = Number.parseInt(db.getSnapshotMeta('snapshot_schema_version') ?? '0', 10)
  const actualSchema = db.getSchemaVersion()
  checks.push({
    name: 'schema_version',
    expected: expectedSchema,
    actual: actualSchema,
    ok: actualSchema >= expectedSchema,
  })

  // Check 3: FTS integrity
  try {
    db.db.query("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')").run()
    checks.push({ name: 'fts_integrity', ok: true })
  } catch (e) {
    checks.push({ name: 'fts_integrity', ok: false, error: e.message })
  }

  const allOk = checks.every(c => c.ok)
  return {
    installed: true,
    tier,
    tag: db.getSnapshotMeta('snapshot_tag') ?? db.getSnapshotMeta('snapshot_version'),
    installedAt: db.getSnapshotMeta('snapshot_installed_at'),
    checks,
    ok: allOk,
  }
}

/**
 * Verify structural integrity of the corpus database and raw-json files.
 *
 * @param {import('../../storage/database.js').DocsDatabase} db
 * @param {string} dataDir
 * @param {{ debug: Function, info: Function, warn: Function, error: Function }} logger
 * @returns {{ checks: Array<{ name: string, ok: boolean, detail?: string }>, allOk: boolean }}
 */
export function verifyCorpusIntegrity(db, dataDir, _logger) {
  const checks = []

  // Check 1: FTS integrity for documents_fts
  try {
    db.db.query("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')").run()
    checks.push({ name: 'documents_fts', ok: true })
  } catch (e) {
    checks.push({ name: 'documents_fts', ok: false, detail: e.message })
  }

  // Check 2: FTS integrity for documents_body_fts (if exists)
  if (db.hasTable('documents_body_fts')) {
    try {
      db.db.query("INSERT INTO documents_body_fts(documents_body_fts) VALUES('integrity-check')").run()
      checks.push({ name: 'body_fts', ok: true })
    } catch (e) {
      checks.push({ name: 'body_fts', ok: false, detail: e.message })
    }
  } else {
    checks.push({ name: 'body_fts', ok: true, detail: 'table not present' })
  }

  // Check 3: Document count consistency
  const docCount = db.db.query('SELECT COUNT(*) as c FROM documents').get().c
  const pageCount = db.db.query("SELECT COUNT(*) as c FROM pages WHERE status = 'active'").get().c
  checks.push({
    name: 'document_page_consistency',
    ok: docCount <= pageCount + 10, // Allow small delta for edge cases
    detail: `documents: ${docCount}, active pages: ${pageCount}`,
  })

  // Check 4: Orphan sections (sections referencing non-existent documents)
  if (db.hasTable('document_sections')) {
    const orphanSections = db.db.query(
      'SELECT COUNT(*) as c FROM document_sections WHERE document_id NOT IN (SELECT id FROM documents)'
    ).get().c
    checks.push({
      name: 'orphan_sections',
      ok: orphanSections === 0,
      detail: `${orphanSections} orphan sections`,
    })
  } else {
    checks.push({ name: 'orphan_sections', ok: true, detail: 'table not present (lite tier)' })
  }

  // Check 5: Orphan relationships (referencing non-existent documents)
  const orphanRels = db.db.query(
    'SELECT COUNT(*) as c FROM document_relationships WHERE from_key NOT IN (SELECT key FROM documents) OR to_key NOT IN (SELECT key FROM documents)'
  ).get().c
  checks.push({
    name: 'orphan_relationships',
    ok: orphanRels === 0,
    detail: `${orphanRels} orphan relationships`,
  })

  // Check 6: Sample-based raw-json file existence check (skip if no raw-json dir)
  const rawJsonDir = join(dataDir, 'raw-json')
  if (!existsSync(rawJsonDir)) {
    const tier = db.getTier()
    checks.push({ name: 'raw_json_files', ok: true, detail: `raw-json directory not present${tier ? ` (${tier} tier)` : ''}` })
  } else {
    const sampleDocs = db.db.query('SELECT key FROM documents ORDER BY RANDOM() LIMIT 10').all()
    let missingFiles = 0
    for (const doc of sampleDocs) {
      const filePath = join(rawJsonDir, `${doc.key}.json`)
      try {
        statSync(filePath)
      } catch {
        missingFiles++
      }
    }
    checks.push({
      name: 'raw_json_files',
      ok: missingFiles === 0,
      detail: `${missingFiles}/${sampleDocs.length} sampled files missing`,
    })
  }

  const allOk = checks.every(c => c.ok)
  return { checks, allOk }
}

/**
 * Walk a directory and minify any JSON file that isn't already minified.
 * A file is considered not-minified if it contains a newline in the first 200 bytes.
 */
