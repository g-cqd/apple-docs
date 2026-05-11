// Update path for "flat" sources (sample-code, swift-evolution, packages,
// swift-book, swift-org, apple-archive). Discover yields a flat list of
// keys; tracked pages get checked for changes, stale pages get tombstoned,
// and undiscovered keys get fetched fresh.

import { persistNormalizedPage } from '../../pipeline/persist.js'
import {
  markFlatSourceFailed,
  markFlatSourceProcessed,
  seedFlatSourceProgress,
} from '../../lib/flat-source-progress.js'
import { filterPagesByRoots, selectRootsForAdapter } from '../command-helpers.js'
import { clearTombstoneCounter, gateAndTombstone404 } from './tombstone-policy.js'

export async function updateFlatSource(adapter, discovery, requestedRoots, _concurrency, semaphore, ctx) {
  const { db, dataDir, logger } = ctx
  const counts = { newCount: 0, modCount: 0, unchangedCount: 0, delCount: 0, errCount: 0 }
  const roots = selectRootsForAdapter(adapter, discovery, db, requestedRoots)
  const root = roots[0] ?? null
  const pages = filterPagesByRoots(db.getPagesBySourceType(adapter.constructor.type), requestedRoots)
  const discoveredKeys = discovery.keys ?? []
  const discoveredKeySet = new Set(discoveredKeys)
  const stalePages = pages.filter(page => !discoveredKeySet.has(page.path))
  const trackedPages = pages.filter(page => discoveredKeySet.has(page.path))
  const existingKeys = new Set(trackedPages.map(page => page.path))

  if (root) {
    seedFlatSourceProgress(db, root.slug, discoveredKeys, existingKeys)
  }

  if (stalePages.length > 0) {
    logger.info(`Removing ${stalePages.length} stale ${adapter.constructor.displayName} pages...`)
    for (const page of stalePages) {
      db.markPageDeleted(page.path)
      counts.delCount++
    }
  }

  if (trackedPages.length > 0) {
    await checkAndPullTrackedPages({
      adapter, trackedPages, root, discoveredKeySet, semaphore, ctx, counts, db, dataDir, logger,
    })
  }

  const newKeys = discoveredKeys.filter(k => !existingKeys.has(k))
  if (newKeys.length > 0) {
    await fetchNewKeys({
      adapter, newKeys, roots, root, semaphore, ctx, counts, db, dataDir, logger,
    })
  }

  // Refresh page counts for every root this adapter manages.
  for (const r of roots) db.updateRootPageCount(r.slug)
  return counts
}

async function checkAndPullTrackedPages({
  adapter, trackedPages, root, discoveredKeySet, semaphore, ctx, counts, db, dataDir, logger,
}) {
  logger.info(`Checking ${trackedPages.length} ${adapter.constructor.displayName} pages for updates...`)
  const modified = []

  await Promise.all(trackedPages.map(page =>
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
            // Per-page 404 from upstream is gated by the N=3 streak;
            // the discovery-driven `stalePages` branch above is
            // unrelated (those keys are missing from the source's own
            // catalog and tombstone immediately).
            if (gateAndTombstone404(db, page.path, logger)) {
              if (root && discoveredKeySet.has(page.path)) {
                markFlatSourceFailed(db, root.slug, page.path, 'Source entry is no longer available')
              }
              counts.delCount++
            }
            break
          default:
            if (root && discoveredKeySet.has(page.path)) {
              markFlatSourceFailed(db, root.slug, page.path, 'Update check failed')
            }
            counts.errCount++
            break
        }
      } catch (e) {
        if (root && discoveredKeySet.has(page.path)) {
          markFlatSourceFailed(db, root.slug, page.path, e.message)
        }
        counts.errCount++
        logger.warn(`Check failed: ${page.path}`, { error: e.message })
      }
    }),
  ))

  if (modified.length === 0) return
  logger.info(`Pulling ${modified.length} modified ${adapter.constructor.displayName} pages...`)
  await Promise.all(modified.map(page =>
    semaphore.run(async () => {
      try {
        const fetchResult = await adapter.fetch(page.path, ctx)
        const normalized = adapter.normalize(page.path, fetchResult.payload)
        adapter.validateNormalizeResult(normalized)

        await persistNormalizedPage({
          db,
          dataDir,
          rootId: page.root_id,
          path: page.path,
          sourceType: adapter.constructor.type,
          rawPayload: fetchResult.payload,
          normalized,
          etag: fetchResult.etag ?? null,
          lastModified: fetchResult.lastModified ?? null,
        })
        if (root && discoveredKeySet.has(page.path)) {
          markFlatSourceProcessed(db, root.slug, page.path)
        }
        counts.modCount++
      } catch (e) {
        if (root && discoveredKeySet.has(page.path)) {
          markFlatSourceFailed(db, root.slug, page.path, e.message)
        }
        counts.errCount++
        logger.warn(`Pull failed: ${page.path}`, { error: e.message })
      }
    }),
  ))
}

async function fetchNewKeys({
  adapter, newKeys, roots, root, semaphore, ctx, counts, db, dataDir, logger,
}) {
  logger.info(`Fetching ${newKeys.length} new ${adapter.constructor.displayName} pages...`)
  // Adapters may publish multiple roots (e.g. swift-docc) — route each new
  // page to the root whose slug matches the key's first segment.
  const rootBySlug = new Map(roots.map(r => [r.slug, r]))
  const fallbackRootId = roots[0]?.id ?? null

  await Promise.all(newKeys.map(key =>
    semaphore.run(async () => {
      try {
        const fetchResult = await adapter.fetch(key, ctx)
        const normalized = adapter.normalize(key, fetchResult.payload)
        adapter.validateNormalizeResult(normalized)

        const owningRoot = rootBySlug.get(key.split('/', 1)[0])
        await persistNormalizedPage({
          db,
          dataDir,
          rootId: owningRoot?.id ?? fallbackRootId,
          path: key,
          sourceType: adapter.constructor.type,
          rawPayload: fetchResult.payload,
          normalized,
          etag: fetchResult.etag ?? null,
          lastModified: fetchResult.lastModified ?? null,
        })
        const trackingRoot = owningRoot ?? root
        if (trackingRoot) markFlatSourceProcessed(db, trackingRoot.slug, key)
        counts.newCount++
      } catch (e) {
        if (root) markFlatSourceFailed(db, root.slug, key, e.message)
        counts.errCount++
        logger.warn(`Fetch failed: ${key}`, { error: e.message })
      }
    }),
  ))
}
