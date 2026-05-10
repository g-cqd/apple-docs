// Update path for DocC-shaped sources (apple-docc, hig, swift-docc) —
// per-page check + pull, plus crawl-from-scratch for any new roots.
// Pulled out of commands/update.js as part of Phase B.

import { crawlRoot } from '../../pipeline/discover.js'
import { persistFetchedDocPage } from '../../pipeline/persist.js'
import { pool } from '../../lib/pool.js'
import { filterPagesByRoots, selectRootsForAdapter } from '../command-helpers.js'
import { clearTombstoneCounter, gateAndTombstone404 } from './tombstone-policy.js'

export async function updateDoccSource(adapter, discovery, requestedRoots, concurrency, parallel, semaphore, ctx) {
  const { db, dataDir, logger } = ctx
  const pages = filterPagesByRoots(db.getPagesBySourceType(adapter.constructor.type), requestedRoots)
  const counts = { newCount: 0, modCount: 0, unchangedCount: 0, delCount: 0, errCount: 0 }
  const modified = []
  const deleted = []
  let checked = 0

  if (pages.length > 0) {
    logger.info(`Checking ${pages.length} ${adapter.constructor.displayName} pages for updates (concurrency: ${concurrency})...`)
  }

  await Promise.all(pages.map(page =>
    semaphore.run(async () => {
      try {
        const result = await adapter.check(page.path, {
          etag: page.etag,
          lastModified: page.last_modified,
          contentHash: page.content_hash,
        }, ctx)

        switch (result.status) {
          case 'unchanged':
            counts.unchangedCount++
            clearTombstoneCounter(db, page.path)
            break
          case 'modified':
            modified.push(page)
            clearTombstoneCounter(db, page.path)
            break
          case 'deleted':
            // Audit 5 §4.3: gate tombstone behind N=3 consecutive 404s.
            // Only push to `deleted` when the streak crosses the
            // threshold; transient flaps stay active for another cycle.
            if (gateAndTombstone404(db, page.path, logger)) {
              deleted.push(page.path)
            }
            break
          default:
            counts.errCount++
            break
        }
      } catch (e) {
        counts.errCount++
        logger.warn(`Check failed: ${page.path}`, { error: e.message })
      }

      checked++
      if (checked % 1000 === 0) {
        logger.info(`Checked ${checked}/${pages.length} (${modified.length} modified, ${deleted.length} deleted)`)
      }
    }),
  ))

  if (pages.length > 0) {
    logger.info(`Check complete for ${adapter.constructor.displayName}: ${modified.length} modified, ${deleted.length} deleted, ${counts.unchangedCount} unchanged, ${counts.errCount} errors`)
  }

  if (modified.length > 0) {
    logger.info(`Pulling ${modified.length} modified ${adapter.constructor.displayName} pages...`)
    await Promise.all(modified.map(page =>
      semaphore.run(async () => {
        try {
          const fetchResult = await adapter.fetch(page.path, ctx)
          await persistFetchedDocPage({
            db,
            dataDir,
            rootId: page.root_id,
            path: page.path,
            sourceType: adapter.constructor.type,
            json: fetchResult.payload,
            etag: fetchResult.etag,
            lastModified: fetchResult.lastModified,
          })
          counts.modCount++
        } catch (e) {
          counts.errCount++
          logger.warn(`Pull failed: ${page.path}`, { error: e.message })
        }
      }),
    ))
  }

  // Pages reach `deleted` only after gateAndTombstone404 has already
  // marked them; the loop here is just for the operator-visible count.
  counts.delCount += deleted.length

  const newRoots = selectRootsForAdapter(adapter, discovery, db, requestedRoots).filter(root => {
    const stats = db.getCrawlStats(root.slug)
    return stats.processed === 0 && stats.pending === 0
  })

  if (newRoots.length > 0) {
    logger.info(`Crawling ${newRoots.length} new ${adapter.constructor.displayName} root(s)...`)

    const runOne = async (root) => {
      try {
        const result = await crawlRoot(db, dataDir, ctx.rateLimiter, root.slug, logger, null, {
          semaphore,
          adapter,
        })
        counts.newCount += result.processed
      } catch (e) {
        counts.errCount++
        logger.warn(`Crawl failed for new root: ${root.slug}`, { error: e.message })
      }
    }

    if (parallel <= 1) {
      for (const root of newRoots) await runOne(root)
    } else {
      await pool(newRoots, parallel, runOne)
    }
  }

  return counts
}
