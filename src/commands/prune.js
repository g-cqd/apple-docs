/**
 * `apple-docs prune` — trim an existing corpus to `<dataDir>/scope.json`
 * WITHOUT re-crawling (issue #7). Deletes every page whose root falls
 * outside the scope (plus its documents, FTS rows, vectors, raw payloads,
 * relationships, and on-disk markdown/raw-json/html), optionally drops
 * fonts/symbols, then VACUUMs to reclaim the space.
 *
 * Requires a scope.json — refusing to "prune to nothing" by accident is
 * the point. `--dry-run` reports what would go; the command is idempotent
 * (re-running on a pruned corpus deletes nothing).
 *
 * Deletion order matters:
 *   1. documents_body_fts by docid (manually maintained — no trigger).
 *   2. documents — the `documents_ad` trigger cleans documents_fts +
 *      documents_trigram; FK cascades clean sections/chunks/vectors/raw.
 *   3. document_render_index + document_relationships by key.
 *   4. pages (real delete, not the tombstone).
 *   5. crawl state + the roots rows themselves.
 */

import { rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ValidationError } from '../lib/errors.js'
import { keyPath } from '../lib/safe-path.js'
import { loadScope, SCOPE_FILE } from '../lib/scope.js'
import { withFileTempStore } from '../storage/pragmas.js'

const BATCH = 900 // SQLite bound-parameter headroom (default cap 999)

export async function prune(/** @type {any} */ opts, /** @type {any} */ ctx) {
  const { db, dataDir, logger } = ctx
  const dryRun = !!opts.dryRun

  const scope = loadScope(dataDir, { logger })
  if (!scope) {
    throw new ValidationError(`prune requires ${join(dataDir, SCOPE_FILE)} — it defines what to KEEP. See the README's "Scoping the corpus" section.`)
  }

  const roots = db.getRoots()
  validateScopeFrameworks(scope, roots)

  const doomedRoots = roots.filter((/** @type {any} */ root) => isRootOutOfScope(root, scope))
  const keptRoots = roots.filter((/** @type {any} */ root) => !isRootOutOfScope(root, scope))

  // Per-root page counts up front: the dry-run report and the real run
  // share the same accounting.
  const plan = doomedRoots.map((/** @type {any} */ root) => ({
    slug: root.slug,
    sourceType: root.source_type,
    pages: db.db.query('SELECT COUNT(*) AS c FROM pages WHERE root_id = ?').get(root.id).c,
  }))
  const totalPages = plan.reduce((/** @type {any} */ sum, /** @type {any} */ r) => sum + r.pages, 0)

  const summary = {
    status: dryRun ? 'dry-run' : 'ok',
    rootsRemoved: doomedRoots.length,
    rootsKept: keptRoots.length,
    pagesRemoved: totalPages,
    documentsRemoved: 0,
    filesRemoved: 0,
    fontsDropped: false,
    symbolsDropped: false,
    byRoot: plan,
  }

  if (dryRun) {
    logger.info(`prune --dry-run: would remove ${doomedRoots.length} roots / ${totalPages} pages; keep ${keptRoots.length} roots`)
    for (const entry of plan) logger.info(`  - ${entry.slug} (${entry.sourceType}): ${entry.pages} pages`)
    if (scope.keepFonts === false) logger.info('  - fonts: would drop catalog + resources/fonts')
    if (scope.keepSymbols === false) logger.info('  - symbols: would drop catalog + renders + resources/symbols')
    return summary
  }

  db.setActivity(
    'prune',
    doomedRoots.map((/** @type {any} */ r) => r.slug),
  )
  try {
    for (const root of doomedRoots) {
      const removed = pruneRoot(db, dataDir, root, logger)
      summary.documentsRemoved += removed.documents
      summary.filesRemoved += removed.files
    }

    for (const root of keptRoots) db.updateRootPageCount(root.slug)

    if (scope.keepFonts === false) {
      db.db.run('DELETE FROM apple_font_files')
      db.db.run('DELETE FROM apple_font_families')
      rmSync(join(dataDir, 'resources', 'fonts'), { recursive: true, force: true })
      summary.fontsDropped = true
    }
    if (scope.keepSymbols === false) {
      // sf_symbols_fts is manually maintained (no delete trigger) — clear
      // it explicitly alongside the catalog and the pre-rendered SVGs.
      if (db.hasTable('sf_symbols_fts')) db.db.run('DELETE FROM sf_symbols_fts')
      if (db.hasTable('sf_symbol_renders')) db.db.run('DELETE FROM sf_symbol_renders')
      db.db.run('DELETE FROM sf_symbols')
      rmSync(join(dataDir, 'resources', 'symbols'), { recursive: true, force: true })
      summary.symbolsDropped = true
    }

    // The static-site checkpoint indexes pages that may be gone now.
    db.clearWebBuildCheckpoint()

    if (!opts.noVacuum) {
      logger.info('Reclaiming free pages (VACUUM)…')
      withFileTempStore(db.db, () => db.db.run('VACUUM'))
      db.db.run('PRAGMA wal_checkpoint(TRUNCATE)')
    }
  } finally {
    db.clearActivity()
  }

  logger.info(
    `Pruned ${summary.rootsRemoved} roots, ${summary.pagesRemoved} pages, ${summary.documentsRemoved} documents, ${summary.filesRemoved} files` +
      `${summary.fontsDropped ? '; fonts dropped' : ''}${summary.symbolsDropped ? '; symbols dropped' : ''}`,
  )
  return summary
}

function isRootOutOfScope(/** @type {any} */ root, /** @type {any} */ scope) {
  if (scope.sources && !scope.sources.includes(root.source_type)) return true
  if (root.source_type === 'apple-docc' && scope.appleDoccFrameworks && !scope.appleDoccFrameworks.includes(root.slug)) return true
  return false
}

/**
 * Strict framework validation: prune deletes data, so a typo'd framework
 * slug must error (listing the valid ones) instead of silently nuking
 * everything else. Only slugs of EXISTING apple-docc roots count.
 */
function validateScopeFrameworks(/** @type {any} */ scope, /** @type {any} */ roots) {
  if (!scope.appleDoccFrameworks) return
  const known = new Set(roots.filter((/** @type {any} */ r) => r.source_type === 'apple-docc').map((/** @type {any} */ r) => r.slug))
  const unknown = scope.appleDoccFrameworks.filter((/** @type {any} */ slug) => !known.has(slug))
  if (unknown.length > 0) {
    const sample = [...known].sort().slice(0, 15).join(', ')
    throw new ValidationError(
      `scope.json: unknown apple-docc framework(s): ${unknown.join(', ')}. ` +
        `Known slugs include: ${sample}${known.size > 15 ? ', …' : ''} (apple-docs frameworks lists them all)`,
    )
  }
}

/** Delete one root's pages + documents + files. Returns counts. */
function pruneRoot(/** @type {any} */ db, /** @type {any} */ dataDir, /** @type {any} */ root, /** @type {any} */ logger) {
  const rows = db.db.query('SELECT id, path FROM pages WHERE root_id = ?').all(root.id)
  let documents = 0
  let files = 0

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const paths = batch.map((/** @type {any} */ r) => r.path)
    const marks = paths.map(() => '?').join(',')

    db.tx(() => {
      const docIds = db.db
        .query(`SELECT id FROM documents WHERE key IN (${marks})`)
        .all(...paths)
        .map((/** @type {any} */ r) => r.id)
      if (docIds.length > 0) {
        const docMarks = docIds.map(() => '?').join(',')
        if (db.hasTable('documents_body_fts')) {
          db.db.run(`DELETE FROM documents_body_fts WHERE rowid IN (${docMarks})`, docIds)
        }
        if (db.hasTable('document_render_index')) {
          db.db.run(`DELETE FROM document_render_index WHERE doc_id IN (${docMarks})`, docIds)
        }
        db.db.run(`DELETE FROM documents WHERE id IN (${docMarks})`, docIds)
        documents += docIds.length
      }
      db.db.run(`DELETE FROM document_relationships WHERE from_key IN (${marks})`, paths)
      db.db.run(
        `DELETE FROM pages WHERE id IN (${batch.map(() => '?').join(',')})`,
        batch.map((/** @type {any} */ r) => r.id),
      )
    })

    // File deletion stays OUTSIDE the transaction: a crash here leaves
    // orphan files (harmless; rerun is idempotent), never a half-deleted DB.
    for (const path of paths) {
      for (const [dir, ext] of [
        ['markdown', '.md'],
        ['raw-json', '.json'],
        ['html', '.html'],
      ]) {
        try {
          unlinkSync(keyPath(dataDir, dir, path, ext))
          files++
        } catch {
          /* not materialized — fine */
        }
      }
    }
  }

  db.clearCrawlState(root.slug)
  db.db.run('DELETE FROM roots WHERE id = ?', [root.id])
  logger.info(`  - ${root.slug}: ${rows.length} pages, ${documents} documents removed`)
  return { documents, files }
}
