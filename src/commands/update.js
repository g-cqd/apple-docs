import { checkDocPage, fetchDocPage } from '../apple/api.js'
import { extractMetadata, extractReferences } from '../apple/extractor.js'
import { sha256 } from '../lib/hash.js'
import { writeJSON, writeText } from '../storage/files.js'
import { convertPage } from '../pipeline/convert.js'
import { discoverRoots, crawlRoot } from '../pipeline/discover.js'
import { renderPage } from '../apple/renderer.js'
import { extractRootSlug } from '../apple/normalizer.js'
import { Semaphore } from '../lib/semaphore.js'
import { join } from 'node:path'

/**
 * Check for documentation updates and pull changes.
 * @param {{ roots?: string[], concurrency?: number, parallel?: number }} opts
 * @param {{ db, dataDir, rateLimiter, logger }} ctx
 */
export async function update(opts, ctx) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const startMs = Date.now()
  const concurrency = opts.concurrency ?? parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '5', 10)
  const semaphore = new Semaphore(concurrency)

  db.setActivity('update', opts.roots ?? null)

  let newCount = 0
  let modCount = 0
  let unchangedCount = 0
  let delCount = 0
  let errCount = 0

  // 1. Refresh root catalog to detect new roots
  try {
    await discoverRoots(db, rateLimiter, logger)
  } catch (e) {
    logger.warn('Failed to refresh root catalog', { error: e.message })
  }

  const rootSlugs = opts.roots?.map(r => r.toLowerCase()) ?? db.getRoots().map(r => r.slug)

  // 2. Check existing pages for changes via ETag — concurrent
  let allPages = db.getAllPagesWithEtag()
  if (opts.roots) {
    const rootSet = new Set(rootSlugs)
    allPages = allPages.filter(p => rootSet.has(p.path.split('/')[0]))
  }

  logger.info(`Checking ${allPages.length} pages for updates (concurrency: ${concurrency})...`)

  const modified = []
  const deleted = []
  let checked = 0

  // Process in concurrent batches using the semaphore
  const checkPromises = allPages.map(({ path, etag }) =>
    semaphore.run(async () => {
      try {
        const result = await checkDocPage(path, etag, rateLimiter)
        switch (result.status) {
          case 'unchanged': unchangedCount++; break
          case 'modified': modified.push({ path, etag: result.etag }); break
          case 'deleted': deleted.push(path); break
          case 'error': errCount++; break
        }
      } catch (e) {
        errCount++
      }
      checked++
      if (checked % 1000 === 0) {
        logger.info(`Checked ${checked}/${allPages.length} (${modified.length} modified, ${deleted.length} deleted)`)
      }
    })
  )
  await Promise.all(checkPromises)

  logger.info(`Check complete: ${modified.length} modified, ${deleted.length} deleted, ${unchangedCount} unchanged, ${errCount} errors`)

  // 3. Pull modified pages — concurrent
  if (modified.length > 0) {
    logger.info(`Pulling ${modified.length} modified pages...`)
    const pullPromises = modified.map(({ path }) =>
      semaphore.run(async () => {
        try {
          const { json, etag, lastModified } = await fetchDocPage(path, rateLimiter)
          const jsonStr = await writeJSON(join(dataDir, 'raw-json', path + '.json'), json)
          const contentHash = sha256(jsonStr)
          db.updatePageAfterDownload(path, etag, lastModified, contentHash)

          // Re-convert inline
          try {
            const markdown = renderPage(json, path)
            await writeText(join(dataDir, 'markdown', path + '.md'), markdown)
            db.markConverted(path)
          } catch {}

          modCount++
        } catch (e) {
          errCount++
          logger.warn(`Pull failed: ${path}`, { error: e.message })
        }
      })
    )
    await Promise.all(pullPromises)
  }

  // 4. Mark deleted pages
  for (const path of deleted) {
    db.markPageDeleted(path)
    delCount++
  }

  // 5. Discover new pages for new roots
  const parallel = opts.parallel ?? 1
  const newRoots = rootSlugs.filter(slug => {
    const stats = db.getCrawlStats(slug)
    return stats.processed === 0 && stats.pending === 0
  })

  if (newRoots.length > 0) {
    logger.info(`Crawling ${newRoots.length} new roots...`)
    const crawlOpts = { semaphore }

    if (parallel <= 1) {
      for (const slug of newRoots) {
        try {
          const result = await crawlRoot(db, dataDir, rateLimiter, slug, logger, null, crawlOpts)
          newCount += result.processed
        } catch (e) {
          logger.warn(`Crawl failed for new root: ${slug}`, { error: e.message })
        }
      }
    } else {
      await pool(newRoots, parallel, async (slug) => {
        try {
          const result = await crawlRoot(db, dataDir, rateLimiter, slug, logger, null, crawlOpts)
          newCount += result.processed
        } catch (e) {
          logger.warn(`Crawl failed for new root: ${slug}`, { error: e.message })
        }
      })
    }
  }

  // Optional body indexing
  if (opts.indexBody) {
    const { indexBodyIncremental } = await import('../pipeline/index-body.js')
    await indexBodyIncremental(db, dataDir, logger)
  }

  const durationMs = Date.now() - startMs

  db.addUpdateLog({
    action: 'update',
    newCount,
    modCount,
    delCount,
    errCount,
    durationMs,
  })

  db.clearActivity()

  return { newCount, modCount, unchangedCount, delCount, errCount, durationMs }
}

function pool(items, limit, fn) {
  const queue = [...items]
  const active = new Set()
  return new Promise((resolve) => {
    function drain() {
      while (active.size < limit && queue.length > 0) {
        const item = queue.shift()
        const p = fn(item).finally(() => { active.delete(p); drain() })
        active.add(p)
      }
      if (active.size === 0 && queue.length === 0) resolve()
    }
    drain()
  })
}
