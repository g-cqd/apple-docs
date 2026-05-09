import { normalizeIdentifier, extractRootSlug } from '../apple/normalizer.js'
import { fetchDocPage } from '../apple/api.js'
import { extractMetadata, extractReferences } from '../apple/extractor.js'
import { renderPage } from '../apple/renderer.js'
import { sha256 } from '../lib/hash.js'
import { pool } from '../lib/pool.js'
import { keyPath } from '../lib/safe-path.js'
import { readJSON, writeJSON, writeText, } from '../storage/files.js'
import { join } from 'node:path'

const CONSOLIDATE_RETRY_CHECKPOINT = 'consolidate:retry-resolved'

import { isInvalidFailedPath, minifyDir } from './consolidate/storage-helpers.js'
import { verifyCorpusIntegrity, verifySnapshot } from './consolidate/integrity.js'

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


// Re-export for callers that imported from this module.
export { verifyCorpusIntegrity }
