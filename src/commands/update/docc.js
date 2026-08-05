// Update path for DocC-shaped sources (apple-docc, hig, swift-docc) —
// per-page check + pull, plus crawl-from-scratch for any new roots.
//
// For apple-docc the per-page HEAD sweep is gated per root by the ETag of
// Apple's per-root index JSON (`/tutorials/data/index/<slug>`): a 304 on the
// index skips every per-page check under that root. Measured on a live sync,
// the ungated sweep was 343k HEADs over ~13 minutes for ~0.5% hits — the
// index gate reduces a no-change sync to ~one conditional request per root.
// A periodic full sweep (and every `--full` run) still checks each page
// individually, because a content-only edit can change a page without
// touching its root index.

import { crawlRoot } from '../../pipeline/discover.js'
import { persistFetchedDocPage } from '../../pipeline/persist.js'
import { pool } from '../../lib/pool.js'
import { fetchRootIndex } from '../../apple/api.js'
import { sha256 } from '../../lib/hash.js'
import { filterPagesByRoots, selectRootsForAdapter } from '../command-helpers.js'
import { clearTombstoneCounter, gateAndTombstone404 } from './tombstone-policy.js'

const FULL_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export async function updateDoccSource(adapter, discovery, requestedRoots, concurrency, parallel, semaphore, ctx) {
  const { db, dataDir, logger } = ctx
  const sourceType = adapter.constructor.type
  const allPages = filterPagesByRoots(db.getPagesBySourceType(sourceType), requestedRoots)
  const counts = { newCount: 0, modCount: 0, unchangedCount: 0, delCount: 0, errCount: 0, skippedCount: 0 }
  const rootSlugById = new Map(db.getRoots().map(root => [root.id, root.slug]))

  // The index pass runs for apple-docc even on a COLD corpus (allPages
  // empty) and on sweep runs: seeding new pages from the per-root index is
  // orthogonal to gating per-page checks, and a cold crawl that skipped it
  // needed three syncs to reach full coverage (~35k index-only pages were
  // invisible to reference walking).
  const indexRoots = sourceType === 'apple-docc'
    ? selectRootsForAdapter(adapter, discovery, db, requestedRoots)
    : []
  const { pages, skipped, commitIndexEtags } = indexRoots.length > 0
    ? await gateByRootIndex(indexRoots, allPages, ctx)
    : { pages: allPages, skipped: 0, commitIndexEtags: null }
  counts.skippedCount = skipped
  if (skipped > 0) {
    logger.info(`Index gate: skipped ${skipped} pages under unchanged roots`)
  }

  const deleted = []
  const errored = []
  let modifiedCount = 0
  let checked = 0

  const persistModifiedPayload = async (page, { json, etag, lastModified }) => {
    const persisted = await persistFetchedDocPage({
      db,
      dataDir,
      rootId: page.root_id,
      path: page.path,
      sourceType,
      json,
      etag,
      lastModified,
    })
    // A modified page is how new children announce themselves: Apple links
    // new symbol pages from updated parents. Seed same-root references into
    // crawl_state so the crawl phase picks them up — without this, new pages
    // under fully-crawled roots are never discovered (the crawl only
    // processes pending rows, and a fully-crawled root has none).
    const rootSlug = rootSlugById.get(page.root_id)
    if (rootSlug && Array.isArray(persisted?.references)) {
      for (const refPath of persisted.references) {
        if (refPath.split('/', 1)[0] === rootSlug) {
          db.seedCrawlIfNew(refPath, rootSlug, (page.url_depth ?? 0) + 1)
        }
      }
    }
    counts.modCount++
  }

  const pullModified = async (page) => {
    const fetchResult = await adapter.fetch(page.path, ctx)
    await persistModifiedPayload(page, {
      json: fetchResult.payload,
      etag: fetchResult.etag,
      lastModified: fetchResult.lastModified,
    })
  }

  // The pages rows already carry consecutive_404_count, so the counter
  // reset only needs a statement when there is actually a streak to clear —
  // not one guarded no-op UPDATE per unchanged page (~343k per sweep).
  const clearStreakIfAny = (page) => {
    if ((page.consecutive_404_count ?? 0) > 0) clearTombstoneCounter(db, page.path)
  }

  const failedPaths = []
  const checkOne = async (page, { collectErrors }) => {
    try {
      const previousState = {
        etag: page.etag,
        lastModified: page.last_modified,
        contentHash: page.content_hash,
      }
      // Conditional GET when the adapter supports it: a 304 costs the same
      // as the old HEAD, and a 200 carries the payload — no second request
      // for modified pages.
      const result = typeof adapter.checkAndFetch === 'function'
        ? await adapter.checkAndFetch(page.path, previousState, ctx)
        : await adapter.check(page.path, previousState, ctx)

      switch (result.status) {
        case 'unchanged':
          counts.unchangedCount++
          clearStreakIfAny(page)
          break
        case 'modified':
          // Pull immediately instead of parking behind a full-sweep barrier:
          // a page found modified in the first second used to wait for the
          // last of 343k checks before its GET started.
          modifiedCount++
          clearStreakIfAny(page)
          try {
            if (result.json) {
              await persistModifiedPayload(page, result)
            } else {
              await pullModified(page)
            }
          } catch (e) {
            counts.errCount++
            logger.warn(`Pull failed: ${page.path}`, { error: e.message })
          }
          break
        case 'deleted':
          // Gate tombstone behind N=3 consecutive 404s. Only push to
          // `deleted` when the streak crosses the threshold; transient
          // flaps stay active for another cycle.
          if (gateAndTombstone404(db, page.path, logger)) {
            deleted.push(page.path)
          }
          break
        default:
          if (collectErrors) {
            errored.push(page)
          } else {
            counts.errCount++
            failedPaths.push(page.path)
            logger.debug?.(`Check errored: ${page.path}`, { error: result.error ?? 'check returned error status' })
          }
          break
      }
    } catch (e) {
      if (collectErrors) {
        errored.push(page)
      } else {
        counts.errCount++
        failedPaths.push(page.path)
      }
      logger.warn(`Check failed: ${page.path}`, { error: e.message })
    }

    checked++
    if (checked % 1000 === 0) {
      logger.info(`Checked ${checked}/${pages.length} (${modifiedCount} modified, ${deleted.length} deleted)`)
    }
  }

  if (pages.length > 0) {
    logger.info(`Checking ${pages.length} ${adapter.constructor.displayName} pages for updates (concurrency: ${concurrency})...`)
    // pool() streams dispatch with an O(1) cursor; wrapping every page in
    // semaphore.run up front used to park 343k waiter closures in the
    // semaphore queue for the whole phase.
    const limit = Math.max(1, Math.min(concurrency, semaphore.max ?? concurrency))
    await pool(pages, limit, page => semaphore.run(() => checkOne(page, { collectErrors: true })))

    // Errored checks were previously silent errCount increments with no
    // retry until the next sync — the page skipped a full cycle of change
    // detection. One in-run retry clears the transient bulk.
    if (errored.length > 0) {
      const retry = errored.splice(0)
      logger.info(`Retrying ${retry.length} errored ${adapter.constructor.displayName} checks...`)
      await pool(retry, limit, page => semaphore.run(() => checkOne(page, { collectErrors: false })))
    }

    if (failedPaths.length > 0) {
      logger.warn(
        `${failedPaths.length} ${adapter.constructor.displayName} checks still failing after retry; ` +
        `sample: ${failedPaths.slice(0, 10).join(', ')}`,
      )
    }

    logger.info(`Check complete for ${adapter.constructor.displayName}: ${counts.modCount} modified, ${deleted.length} deleted, ${counts.unchangedCount} unchanged, ${counts.errCount} errors, ${counts.skippedCount} index-gated`)
  }

  // Persist the fresh index ETags only now that this run actually checked
  // the pages under those roots — a crash mid-check must not leave an ETag
  // that would gate-skip unchecked pages on the next run.
  commitIndexEtags?.()

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

/**
 * Per-root index pass for apple-docc. Two orthogonal jobs:
 *
 *   1. SEEDING (always): conditional-GET each root's index JSON — the
 *      authoritative page inventory — and seed unknown same-root paths into
 *      crawl_state. Runs on cold corpora and sweep runs too: a 304 proves
 *      the previously-seeded inventory is current, a 200 seeds the delta.
 *
 *   2. GATING (skipped on `--full` and the periodic sweep): partition the
 *      tracked pages into { needs-per-page-check, skipped } using the index
 *      ETag with a content-hash fallback (CDN edges rotate ETags over
 *      identical bodies).
 */
async function gateByRootIndex(indexRoots, allPages, ctx) {
  const { db, logger } = ctx

  const sweepKey = 'docc_full_sweep_at'
  const lastSweep = db.db.query('SELECT value FROM schema_meta WHERE key = ?').get(sweepKey)?.value ?? null
  const sweepDue = !lastSweep || (Date.now() - Date.parse(lastSweep)) > FULL_SWEEP_INTERVAL_MS
  const checkAll = !!ctx.fullSync || sweepDue
  if (checkAll) {
    // Stamp at sweep start so an interrupted sweep re-runs next time.
    db.db.run('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)', [sweepKey, new Date().toISOString()])
    logger.info(ctx.fullSync ? 'Full sweep: --full run checks every page' : 'Full sweep: periodic per-page check due')
  }

  const pagesByRoot = new Map()
  for (const page of allPages) {
    let list = pagesByRoot.get(page.root_id)
    if (!list) { list = []; pagesByRoot.set(page.root_id, list) }
    list.push(page)
  }

  const getEtagStmt = db.db.query('SELECT index_etag FROM roots WHERE id = ?')
  const setEtagStmt = db.db.query('UPDATE roots SET index_etag = ? WHERE id = ?')
  const getHashStmt = db.db.query('SELECT value FROM schema_meta WHERE key = ?')
  const setHashStmt = db.db.query('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')

  const toCheck = []
  const pendingEtags = []
  let skipped = 0
  let seeded = 0
  let etagRotations = 0
  await pool(indexRoots, 16, async (root) => {
    const rootPages = pagesByRoot.get(root.id) ?? []
    const takePages = () => { if (!checkAll) toCheck.push(...rootPages) }
    const storedEtag = getEtagStmt.get(root.id)?.index_etag ?? null
    const result = await fetchRootIndex(root.slug, storedEtag, ctx.rateLimiter)
    if (result.status === 'unchanged' && storedEtag) {
      // 304: inventory unchanged since the last 200 (which already seeded
      // its content) — nothing new to seed, and gated runs skip the pages.
      if (!checkAll) skipped += rootPages.length
      return
    }
    if (result.status === 'modified' && result.json) {
      const hashKey = `root_index_hash:${root.slug}`
      const bodyHash = sha256(JSON.stringify(result.json))
      const storedHash = getHashStmt.get(hashKey)?.value ?? null
      if (storedHash === bodyHash) {
        // Rotated ETag over identical content: adopt the fresh ETag now
        // (nothing goes unchecked — the content is proven unchanged).
        etagRotations++
        if (!checkAll) skipped += rootPages.length
        if (result.etag) setEtagStmt.run(result.etag, root.id)
        return
      }
      seeded += seedNewPagesFromIndex(db, root.slug, result.json, rootPages)
      if (result.etag) pendingEtags.push({ rootId: root.id, etag: result.etag, hashKey, bodyHash })
      takePages()
      return
    }
    // Missing index (404), first sight (no stored etag), or error: fall
    // through to per-page checks on gated runs. The fresh etag is committed
    // by the caller only after the page checks actually ran.
    if (result.etag) pendingEtags.push({ rootId: root.id, etag: result.etag })
    takePages()
  })

  if (seeded > 0) logger.info(`Index diff: seeded ${seeded} new pages into the crawl queue`)
  if (etagRotations > 0) logger.info(`Index gate: ${etagRotations} roots had rotated ETags over identical content`)

  const commitIndexEtags = () => {
    for (const { rootId, etag, hashKey, bodyHash } of pendingEtags) {
      setEtagStmt.run(etag, rootId)
      if (hashKey && bodyHash) setHashStmt.run(hashKey, bodyHash)
    }
  }
  return { pages: checkAll ? allPages : toCheck, skipped, commitIndexEtags }
}

/**
 * Walk a root-index JSON (`interfaceLanguages` → recursive `children`
 * trees) and seed every same-root documentation path the corpus doesn't
 * track yet. Returns the number of newly seeded paths.
 */
function seedNewPagesFromIndex(db, slug, indexJson, rootPages) {
  const known = new Set(rootPages.map(page => page.path))
  const prefix = `${slug.toLowerCase()}/`
  let seeded = 0
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.path === 'string' && !node.external) {
      const key = node.path.replace(/^\/documentation\//i, '').toLowerCase()
      if (key !== node.path && (key === slug || key.startsWith(prefix)) && !known.has(key)) {
        known.add(key)
        if (db.seedCrawlIfNew(key, slug, Math.max(0, key.split('/').length - 1))) seeded++
      }
    }
    if (Array.isArray(node.children)) for (const child of node.children) visit(child)
  }
  const languages = indexJson?.interfaceLanguages ?? {}
  for (const nodes of Object.values(languages)) {
    if (Array.isArray(nodes)) for (const node of nodes) visit(node)
  }
  return seeded
}
