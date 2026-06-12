import { join } from 'node:path'
import { statSync, existsSync, rmSync } from 'node:fs'
import { dirSize, fileCount, ensureDir, writeText } from '../storage/files.js'
import { nativeDocMarkdownBatch } from '../content/content-native.js'
import { renderMarkdown } from '../content/render-markdown.js'
import { renderHtml } from '../content/render-html.js'
import { pool } from '../lib/pool.js'
import { keyPath } from '../lib/safe-path.js'
import { decodeSectionContent } from '../storage/section-codec.js'
import { withFileTempStore } from '../storage/pragmas.js'

/**
 * Returns a storage breakdown: DB file size, rendered output dirs, raw JSON,
 * and per-table row counts.
 *
 * @param {object} opts
 * @param {{ db: import('../storage/database.js').DocsDatabase, dataDir: string }} ctx
 */
export function storageStats(_opts, ctx) {
  const { db, dataDir } = ctx

  const dbPath = join(dataDir, 'apple-docs.db')
  let dbSize = 0
  try {
    dbSize = statSync(dbPath).size
    // Also account for the WAL file when present
    if (existsSync(`${dbPath}-wal`)) {
      dbSize += statSync(`${dbPath}-wal`).size
    }
  } catch {
    dbSize = 0
  }

  const rawJsonPath = join(dataDir, 'raw-json')
  const markdownPath = join(dataDir, 'markdown')
  const htmlPath = join(dataDir, 'html')
  const resourcesPath = join(dataDir, 'resources')

  const rawJson = {
    size: dirSize(rawJsonPath),
    files: fileCount(rawJsonPath),
  }

  const markdown = {
    size: dirSize(markdownPath),
    files: fileCount(markdownPath),
  }

  const html = {
    size: dirSize(htmlPath),
    files: fileCount(htmlPath),
  }

  // Pre-rendered SF Symbols + extracted fonts. Previously omitted, which made
  // the reported total understate real disk usage by ~2 GB on a full corpus.
  const resources = {
    size: dirSize(resourcesPath),
    files: fileCount(resourcesPath),
  }

  const tables = {
    documents: db.db.query('SELECT COUNT(*) as count FROM documents').get().count,
    document_sections: db.hasTable('document_sections') ? db.db.query('SELECT COUNT(*) as count FROM document_sections').get().count : 0,
    pages: db.db.query('SELECT COUNT(*) as count FROM pages').get().count,
    roots: db.db.query('SELECT COUNT(*) as count FROM roots').get().count,
    crawl_state: db.db.query('SELECT COUNT(*) as count FROM crawl_state').get().count,
  }

  const total = dbSize + rawJson.size + markdown.size + html.size + resources.size

  return {
    database: { size: dbSize, path: dbPath },
    rawJson,
    markdown,
    html,
    resources,
    tables,
    total,
  }
}

/**
 * Garbage-collect stale data: drop rendered output directories, remove orphan
 * DB rows, and optionally VACUUM the database.
 *
 * @param {{ drop?: string[], olderThan?: number, vacuum?: boolean }} opts
 * @param {{ db: import('../storage/database.js').DocsDatabase, dataDir: string, logger?: object }} ctx
 * @returns {{ droppedDirs: string[], orphansCleaned: number, vacuumed: boolean }}
 */
export function storageGc(opts, ctx) {
  const { db, dataDir, logger } = ctx
  const _opts = opts ?? {}
  const { drop = [], vacuum = true, olderThan = null } = _opts

  const droppedDirs = []

  if (drop.includes('markdown')) {
    const markdownPath = join(dataDir, 'markdown')
    rmSync(markdownPath, { recursive: true, force: true })
    ensureDir(markdownPath)
    droppedDirs.push('markdown')
    logger?.info?.('Dropped markdown directory')
  }

  if (drop.includes('html')) {
    const htmlPath = join(dataDir, 'html')
    rmSync(htmlPath, { recursive: true, force: true })
    ensureDir(htmlPath)
    droppedDirs.push('html')
    logger?.info?.('Dropped html directory')
  }

  // Remove orphan crawl_state entries (root_slug not in roots)
  db.db.run('DELETE FROM crawl_state WHERE root_slug NOT IN (SELECT slug FROM roots)')
  let orphansCleaned = db.db.query('SELECT changes() as c').get().c

  // Remove stale activity records. The activity table's own column is
  // `started_at` (v2 migration) — earlier code referenced a
  // non-existent `timestamp` column and threw at every gc invocation
  // with an --older-than flag set.
  if (olderThan != null) {
    db.db.run("DELETE FROM activity WHERE started_at < datetime('now', '-' || ? || ' days')", [Math.max(1, Math.floor(olderThan))])
  } else {
    db.db.run('DELETE FROM activity')
  }
  orphansCleaned += db.db.query('SELECT changes() as c').get().c

  if (vacuum) {
    withFileTempStore(db.db, () => db.db.run('VACUUM'))
    logger?.info?.('VACUUM complete')
  }

  return { droppedDirs, orphansCleaned, vacuumed: vacuum }
}

/**
 * Read-only orphan / FK-violation report. Used as the operator gate before
 * trusting the new PRAGMA foreign_keys=ON to enforce on writes — surfaces
 * pre-existing violations in old corpora without auto-deleting anything.
 *
 * Combines:
 *   1. Engine-level `PRAGMA foreign_key_check` — hits the declared FKs
 *      (pages.root_id → roots.id; the asset cascades; document_sections
 *      etc).
 *   2. A handful of semantic orphans not modeled as FKs (e.g. documents
 *      keyed by path that are no longer in pages).
 *
 * @param {object} _opts unused
 * @param {{ db: import('../storage/database.js').DocsDatabase }} ctx
 * @returns {{ fkViolations: object[], semanticOrphans: object }}
 */
export function storageCheckOrphans(_opts, ctx) {
  const { db } = ctx
  const fkViolations = db.db.query('PRAGMA foreign_key_check').all()

  const semanticOrphans = {
    crawlStateMissingRoot: db.db
      .query('SELECT COUNT(*) AS count FROM crawl_state WHERE root_slug NOT IN (SELECT slug FROM roots)')
      .get().count,
    documentsMissingPage: db.hasTable('documents')
      ? db.db.query('SELECT COUNT(*) AS count FROM documents WHERE key NOT IN (SELECT path FROM pages)').get().count
      : 0,
  }

  return { fkViolations, semanticOrphans }
}

/**
 * Force-materialize rendered files (Markdown or HTML) for all documents or a
 * filtered subset.
 *
 * @param {{ format?: 'markdown' | 'html', roots?: string[] }} opts
 * @param {{ db: import('../storage/database.js').DocsDatabase, dataDir: string, logger?: object }} ctx
 * @returns {Promise<{ materialized: number, format: string }>}
 */
export async function storageMaterialize(opts, ctx) {
  const { db, dataDir, logger } = ctx
  const { format = 'markdown', roots } = opts ?? {}

  // raw-json: decompress the raw upstream payloads shipped in the DB
  // (document_raw) to loose files on disk, re-enabling local re-normalization.
  if (format === 'raw-json') {
    if (!db.hasTable('document_raw')) {
      logger?.info?.('No document_raw to materialize (raw payloads not shipped in this snapshot).')
      return { format, materialized: 0 }
    }
    const rows = db.db.query('SELECT dr.document_id AS id, d.key AS key FROM document_raw dr JOIN documents d ON d.id = dr.document_id').all()
    const getRaw = db.db.query('SELECT raw FROM document_raw WHERE document_id = ?')
    let materialized = 0
    await pool(rows, 50, async (row) => {
      const blob = getRaw.get(row.id)
      if (!blob) return
      try {
        await writeText(keyPath(dataDir, 'raw-json', row.key, '.json'), decodeSectionContent(blob.raw))
        materialized++
      } catch (err) {
        logger?.error?.(`raw-json materialize failed for ${row.key}: ${err.message}`)
      }
    })
    logger?.info?.(`Materialized ${materialized} raw-json files.`)
    return { format, materialized }
  }

  let _docsQuery
  let docsRows

  if (roots && roots.length > 0) {
    const placeholders = roots.map(() => '?').join(', ')
    docsRows = db.db.query(
      `SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.abstract_text, d.declaration_text, d.source_type
       FROM documents d
       JOIN pages p ON p.path = d.key
       JOIN roots r ON p.root_id = r.id
       WHERE r.slug IN (${placeholders}) AND p.status = 'active'
       ORDER BY d.key`
    ).all(...roots)
  } else {
    docsRows = db.db.query(
      `SELECT id, key, title, kind, role, role_heading, framework, abstract_text, declaration_text, source_type
       FROM documents
       ORDER BY key`
    ).all()
  }

  const getSections = db.hasTable('document_sections') ? db.db.query(
    `SELECT section_kind, heading, content_text, content_json, sort_order
     FROM document_sections
     WHERE document_id = ?
     ORDER BY sort_order, id`
  ) : null

  let materialized = 0

  if (!getSections) {
    logger.info('document_sections table not available (lite tier) — cannot materialize')
    return { format, materialized: 0, total: docsRows.length }
  }

  // Markdown leg: batched native render when the `content` module is
  // enabled (Swift renders the batch in parallel; JS keeps the writes).
  // Any null — module off, dylib absent, codec mismatch — falls through
  // to the per-doc pool unchanged.
  let remaining = docsRows
  if (format !== 'html') {
    const BATCH = 100
    let nativeServed = true
    for (let start = 0; start < docsRows.length && nativeServed; start += BATCH) {
      const chunk = docsRows.slice(start, start + BATCH)
      const entries = chunk.map((doc) => ({ document: doc, sections: getSections.all(doc.id) }))
      const rendered = nativeDocMarkdownBatch(entries)
      if (rendered === null) {
        remaining = docsRows.slice(start)
        nativeServed = false
        break
      }
      for (let i = 0; i < chunk.length; i++) {
        const doc = chunk[i]
        const content = rendered[i] ?? renderMarkdown(entries[i].document, entries[i].sections)
        const outPath = keyPath(dataDir, 'markdown', doc.key, '.md')
        try {
          await writeText(outPath, content)
          materialized++
        } catch (err) {
          logger?.error?.(`Failed to write ${outPath}: ${err.message}`)
        }
      }
    }
    if (nativeServed) remaining = []
  }

  await pool(remaining, 50, async (doc) => {
    const sections = getSections.all(doc.id)

    let content
    let outPath

    if (format === 'html') {
      content = renderHtml(doc, sections)
      outPath = keyPath(dataDir, 'html', doc.key, '.html')
    } else {
      content = renderMarkdown(doc, sections)
      outPath = keyPath(dataDir, 'markdown', doc.key, '.md')
    }

    try {
      await writeText(outPath, content)
      materialized++
    } catch (err) {
      logger?.error?.(`Failed to write ${outPath}: ${err.message}`)
    }
  })

  return { materialized, format }
}
