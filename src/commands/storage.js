import { join } from 'node:path'
import { statSync, existsSync, rmSync } from 'node:fs'
import { dirSize, fileCount, ensureDir, writeText } from '../storage/files.js'
import { renderMarkdown } from '../content/render-markdown.js'
import { renderHtml } from '../content/render-html.js'
import { pool } from '../lib/pool.js'

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

  const tables = {
    documents: db.db.query('SELECT COUNT(*) as count FROM documents').get().count,
    document_sections: db.hasTable('document_sections') ? db.db.query('SELECT COUNT(*) as count FROM document_sections').get().count : 0,
    pages: db.db.query('SELECT COUNT(*) as count FROM pages').get().count,
    roots: db.db.query('SELECT COUNT(*) as count FROM roots').get().count,
    crawl_state: db.db.query('SELECT COUNT(*) as count FROM crawl_state').get().count,
    refs: db.db.query('SELECT COUNT(*) as count FROM refs').get().count,
  }

  const total = dbSize + rawJson.size + markdown.size + html.size

  return {
    database: { size: dbSize, path: dbPath },
    rawJson,
    markdown,
    html,
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

  // Remove orphan refs (source page deleted or missing)
  db.db.run("DELETE FROM refs WHERE source_id NOT IN (SELECT id FROM pages WHERE status = 'active')")
  orphansCleaned += db.db.query('SELECT changes() as c').get().c

  // Remove stale activity records
  if (olderThan != null) {
    db.db.run("DELETE FROM activity WHERE timestamp < datetime('now', '-' || ? || ' days')", [Math.max(1, Math.floor(olderThan))])
  } else {
    db.db.run('DELETE FROM activity')
  }
  orphansCleaned += db.db.query('SELECT changes() as c').get().c

  if (vacuum) {
    db.db.run('VACUUM')
    logger?.info?.('VACUUM complete')
  }

  return { droppedDirs, orphansCleaned, vacuumed: vacuum }
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

  await pool(docsRows, 50, async (doc) => {
    const sections = getSections.all(doc.id)

    let content
    let outPath

    if (format === 'html') {
      content = renderHtml(doc, sections)
      outPath = join(dataDir, 'html', `${doc.key}.html`)
    } else {
      content = renderMarkdown(doc, sections)
      outPath = join(dataDir, 'markdown', `${doc.key}.md`)
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
