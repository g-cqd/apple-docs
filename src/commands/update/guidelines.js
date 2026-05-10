// Update path for snapshot-style sources (currently just the App Store
// Review Guidelines): a single fetched HTML blob that gets re-applied
// when the upstream ETag drifts.
//
// Pulled out of commands/update.js as part of Phase B.

import { applyGuidelinesSnapshot } from '../../pipeline/sync-guidelines.js'
import { filterPagesByRoots, selectRootsForAdapter } from '../command-helpers.js'
import { clearTombstoneCounter, gateAndTombstone404 } from './tombstone-policy.js'

export async function updateGuidelinesSource(adapter, discovery, requestedRoots, ctx) {
  const { db, dataDir, logger } = ctx
  const counts = { newCount: 0, modCount: 0, unchangedCount: 0, delCount: 0, errCount: 0 }
  const roots = selectRootsForAdapter(adapter, discovery, db, requestedRoots)

  if (roots.length === 0) return counts

  const pages = filterPagesByRoots(db.getPagesBySourceType(adapter.constructor.type), requestedRoots)
  const previousState = pages[0]
    ? { etag: pages[0].etag, lastModified: pages[0].last_modified, contentHash: pages[0].content_hash }
    : null

  logger.info(`Checking ${adapter.constructor.displayName} for updates...`)

  let result
  try {
    result = await adapter.check(roots[0].slug, previousState, ctx)
  } catch (e) {
    counts.errCount++
    logger.warn(`${adapter.constructor.displayName} update check failed`, { error: e.message })
    return counts
  }

  switch (result.status) {
    case 'unchanged':
      counts.unchangedCount += pages.length
      for (const page of pages) clearTombstoneCounter(db, page.path)
      return counts
    case 'deleted':
      // Audit 5 §4.3: gate per-page tombstone behind N=3 consecutive
      // 404s. Guidelines is a single-blob source; every page in `pages`
      // shares the upstream check result, so they all bump together.
      for (const page of pages) {
        if (gateAndTombstone404(db, page.path, logger)) {
          counts.delCount++
        }
      }
      return counts
    case 'error':
      counts.errCount++
      return counts
    default:
      break
  }

  const fetchResult = await adapter.fetch(roots[0].slug, ctx)
  const syncResult = await applyGuidelinesSnapshot(db, dataDir, {
    html: fetchResult.payload.html,
    etag: fetchResult.etag,
    lastModified: fetchResult.lastModified,
    sections: fetchResult.payload.sections,
    lastUpdated: fetchResult.payload.lastUpdated,
  })

  logger.info(`Guidelines re-synced: ${syncResult.sections} sections`)

  if (pages.length === 0) {
    counts.newCount += syncResult.sections
  } else {
    counts.modCount += syncResult.sections
  }

  return counts
}
