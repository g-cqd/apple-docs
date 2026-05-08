import { normalizeIdentifier, extractRootSlug } from '../apple/normalizer.js'
import { fetchDocPage } from '../apple/api.js'
import { extractMetadata, extractReferences } from '../apple/extractor.js'
import { renderPage } from '../apple/renderer.js'
import { sha256 } from '../lib/hash.js'
import { pool } from '../lib/pool.js'
import { keyPath } from '../lib/safe-path.js'
import { readJSON, writeJSON, writeText, stableStringify } from '../storage/files.js'
import { join } from 'node:path'
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'

const CONSOLIDATE_RETRY_CHECKPOINT = 'consolidate:retry-resolved'

function isInvalidFailedPath(path) {
  const renorm = normalizeIdentifier(path)
  return renorm === null || path.includes('#') || (renorm !== path && renorm !== null)
}

/**
 * Consolidate command: analyze and fix failed crawl entries.
 *
 * 1. Cleans up entries that are now rejected by the updated normalizer (fragments, dot-ops)
 * 2. Re-resolves remaining failures by checking parent page references for correct URLs
 * 3. Retries re-resolved paths
 *
 * @param {{ dryRun?: boolean, minify?: boolean }} opts
 * @param {{ db, dataDir, rateLimiter, logger }} ctx
 */
export async function consolidate(opts, ctx) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const dryRun = opts.dryRun ?? false

  db.setActivity('consolidate')
  try {
    let analyzed = 0
    let cleaned = 0
    let resolved = 0
    let retried = 0
    let retriedOk = 0
    let resolvedPaths = []

    const retryCheckpoint = dryRun ? null : db.getSyncCheckpoint(CONSOLIDATE_RETRY_CHECKPOINT)
    if (retryCheckpoint) {
      analyzed = retryCheckpoint.analyzed ?? 0
      cleaned = retryCheckpoint.cleaned ?? 0
      resolved = retryCheckpoint.resolved ?? 0
      retried = retryCheckpoint.retried ?? 0
      retriedOk = retryCheckpoint.retriedOk ?? 0
      resolvedPaths = retryCheckpoint.resolvedPaths ?? []
      logger.info(`Resuming ${resolvedPaths.length - (retryCheckpoint.nextIndex ?? 0)} resolved retries from checkpoint...`)
    } else {
      const all = db.db.query("SELECT path, root_slug, error FROM crawl_state WHERE status = 'failed'").all()
      analyzed = all.length
      logger.info(`Analyzing ${all.length} failed entries...`)

      // Phase 1: clean up entries that are not valid standalone pages
      for (const failed of all) {
        if (!isInvalidFailedPath(failed.path)) continue
        if (!dryRun) {
          db.db.run("DELETE FROM crawl_state WHERE path = ?", [failed.path])
        }
        cleaned++
      }
      logger.info(`Cleaned ${cleaned} invalid entries (fragments, dot-operators, bad URLs)`)

      // Phase 2: for remaining failures, check parent pages for correct URL
      const remaining = dryRun
        ? all.filter(failed => !isInvalidFailedPath(failed.path))
        : db.db.query("SELECT path, root_slug, error FROM crawl_state WHERE status = 'failed'").all()

      for (const failed of remaining) {
        const segments = failed.path.split('/')
        if (segments.length < 2) continue

        const parentPath = segments.slice(0, -1).join('/')
        const parentJson = await readJSON(keyPath(dataDir, 'raw-json', parentPath, '.json'))
        if (!parentJson) continue

        for (const [id, ref] of Object.entries(parentJson.references ?? {})) {
          const normId = normalizeIdentifier(id)
          if (normId !== failed.path || !ref.url) continue

          const urlPath = normalizeIdentifier(ref.url)
          if (urlPath && urlPath !== failed.path) {
            resolvedPaths.push({ oldPath: failed.path, newPath: urlPath, root: failed.root_slug, title: ref.title })
            resolved++
            break
          }
        }
      }

      logger.info(`Resolved ${resolved} paths to correct URLs`)

      if (!dryRun && resolvedPaths.length > 0) {
        db.setSyncCheckpoint(CONSOLIDATE_RETRY_CHECKPOINT, {
          analyzed,
          cleaned,
          resolved,
          retried,
          retriedOk,
          nextIndex: 0,
          resolvedPaths,
        })
      }
    }

    // Phase 3: retry resolved paths (unless dry-run)
    if (!dryRun && resolvedPaths.length > 0) {
      logger.info(`Retrying ${resolvedPaths.length} resolved paths...`)
      const concurrency = Math.max(
        1,
        ctx.semaphore?.max ?? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '5', 10),
      )
      let nextIndex = retryCheckpoint?.nextIndex ?? 0

      while (nextIndex < resolvedPaths.length) {
        const batch = resolvedPaths.slice(nextIndex, nextIndex + concurrency)
        await pool(batch, concurrency, async ({ oldPath, newPath, root }) => {
          const existing = db.getPage(newPath)
          if (existing) {
            db.db.run("DELETE FROM crawl_state WHERE path = ?", [oldPath])
            retried++
            retriedOk++
            return
          }

          try {
            const { json, etag, lastModified } = await fetchDocPage(newPath, rateLimiter)
            const jsonStr = await writeJSON(keyPath(dataDir, 'raw-json', newPath, '.json'), json)
            const contentHash = sha256(jsonStr)
            const meta = extractMetadata(json)
            const rootSlug = extractRootSlug(newPath)
            const rootEntry = db.getRootBySlug(rootSlug ?? root)

            if (rootEntry) {
              db.upsertPage({
                rootId: rootEntry.id,
                path: newPath,
                url: `https://developer.apple.com/tutorials/data/documentation/${newPath}.json`,
                title: meta.title,
                role: meta.role,
                roleHeading: meta.roleHeading,
                abstract: meta.abstract,
                platforms: meta.platforms,
                declaration: meta.declaration,
                etag,
                lastModified,
                contentHash,
                downloadedAt: new Date().toISOString(),
              })

              try {
                const markdown = renderPage(json, newPath)
                await writeText(keyPath(dataDir, 'markdown', newPath, '.md'), markdown)
                db.markConverted(newPath)
              } catch {}

              const refs = extractReferences(json)
              for (const refPath of refs) {
                const refRoot = extractRootSlug(refPath)
                if (refRoot === rootSlug) {
                  db.seedCrawlIfNew(refPath, rootSlug, 0)
                }
              }
            }

            db.setCrawlState(newPath, 'processed', root, 0)
            db.db.run("DELETE FROM crawl_state WHERE path = ?", [oldPath])
            retried++
            retriedOk++
          } catch (error) {
            db.setCrawlState(oldPath, 'failed', root, 0, error.message)
            retried++
            logger.warn(`Retry failed: ${newPath}`, { error: error.message })
          }
        })

        nextIndex += batch.length
        db.setSyncCheckpoint(CONSOLIDATE_RETRY_CHECKPOINT, {
          analyzed,
          cleaned,
          resolved,
          retried,
          retriedOk,
          nextIndex,
          resolvedPaths,
        })
        ctx.onProgress?.({
          phase: 'consolidate-retry',
          completed: nextIndex,
          total: resolvedPaths.length,
          retried,
          retriedOk,
        })
      }

      db.clearSyncCheckpoint(CONSOLIDATE_RETRY_CHECKPOINT)
    }

    const stillFailed = db.db.query("SELECT COUNT(*) as c FROM crawl_state WHERE status = 'failed'").get().c

    // Phase 4: minify existing JSON files if requested
    let minified = 0
    let minifySaved = 0

    if (opts.minify && !dryRun) {
      const rawDir = join(dataDir, 'raw-json')
      logger.info('Minifying JSON files...')
      const result = minifyDir(rawDir, logger)
      minified = result.count
      minifySaved = result.saved
      logger.info(`Minified ${minified} files, saved ${(minifySaved / 1e6).toFixed(1)} MB`)
    }

    // Phase 5: rebuild body index if requested
    let bodyIndexed = 0
    if (opts.indexBody && !dryRun) {
      const { indexBodyFull } = await import('../pipeline/index-body.js')
      const idxResult = await indexBodyFull(db, dataDir, logger)
      bodyIndexed = idxResult.indexed
    }

    // Phase 6: verify snapshot/corpus integrity (if requested)
    let snapshotVerification = null
    let corpusIntegrity = null
    if (opts.verify) {
      snapshotVerification = verifySnapshot(db, logger)
      corpusIntegrity = verifyCorpusIntegrity(db, dataDir, logger)
    }

    return {
      analyzed,
      cleaned,
      resolved,
      retried,
      retriedOk,
      genuine: stillFailed,
      minified,
      minifySaved,
      bodyIndexed,
      snapshotVerification,
      corpusIntegrity,
      resolvedPaths: dryRun ? resolvedPaths : undefined,
      dryRun,
    }
  } finally {
    db.clearActivity()
  }
}

function verifySnapshot(db, _logger) {
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
 * @param {import('../storage/database.js').DocsDatabase} db
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
function minifyDir(dirPath, logger) {
  let count = 0
  let saved = 0

  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.json')) continue

      try {
        const raw = readFileSync(full)

        // Quick check: skip files that aren't actually JSON (e.g. Markdown/HTML from flat sources)
        const head = raw.subarray(0, Math.min(200, raw.length))
        const firstByte = head.length > 0 ? head[0] : 0
        if (firstByte !== 123 && firstByte !== 91) continue // 123 = '{', 91 = '['

        // Already minified if no newline in first 200 bytes
        if (!head.includes(10)) continue // 10 = '\n'

        const obj = JSON.parse(raw)
        const minStr = stableStringify(obj)
        const oldSize = raw.length
        const newSize = Buffer.byteLength(minStr)

        if (newSize < oldSize) {
          writeFileSync(full, minStr)
          saved += oldSize - newSize
          count++
        }
      } catch (e) {
        logger.warn(`Minify failed: ${full}`, { error: e.message })
      }

      if (count > 0 && count % 5000 === 0) {
        logger.info(`Minified ${count} files so far (${(saved / 1e6).toFixed(1)} MB saved)...`)
      }
    }
  }

  walk(dirPath)
  return { count, saved }
}
