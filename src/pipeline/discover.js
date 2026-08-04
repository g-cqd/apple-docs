import { NotFoundError } from '../lib/errors.js'
import { normalizeIdentifier, extractRootSlug } from '../apple/normalizer.js'
import { fetchDocPage, fetchTechnologies } from '../apple/api.js'
import { persistFetchedDocPage } from './persist.js'

const KIND_MAP = {
  'App Frameworks': 'framework',
  'App Services': 'framework',
  'Developer Tools': 'tooling',
  'Graphics and Games': 'framework',
  'Media': 'framework',
  'Release Notes': 'release-notes',
  'System': 'framework',
  'Web': 'framework',
  'Design': 'technology',
  'Technology Overviews': 'technology',
  'Sample Code': 'tutorial',
}

/**
 * Discover documentation roots from the technologies index.
 * @returns {number} Number of roots discovered
 */
export async function discoverRoots(db, rateLimiter, logger) {
  logger.info('Fetching technologies index...')
  const { json } = await fetchTechnologies(rateLimiter)

  let count = 0
  for (const section of json.sections ?? []) {
    for (const group of section.groups ?? []) {
      const kind = KIND_MAP[group.name] ?? 'unknown'
      for (const tech of group.technologies ?? []) {
        const id = normalizeIdentifier(tech.destination?.identifier)
        if (!id) continue
        const slug = extractRootSlug(id)
        if (!slug) continue

        db.upsertRoot(slug, tech.title, kind, 'apple-index')
        count++
      }
    }
  }

  // HIG uses /design/ instead of /documentation/. Apple's technologies index
  // points to it via https:// URL (which we reject). Register it explicitly
  // with its actual seed path.
  db.upsertRoot('design', 'Human Interface Guidelines', 'design', 'apple-index', 'design/human-interface-guidelines')
  count++

  // App Store Review Guidelines are an HTML page, not DocC JSON.
  // Register here so it appears in list_frameworks; actual sync handled by sync-guidelines.js.
  db.upsertRoot('app-store-review', 'App Store Review Guidelines', 'guidelines', 'html-scrape')
  count++

  logger.info(`Discovered ${count} documentation roots`)
  return count
}

/**
 * Crawl a single root's documentation pages via BFS.
 * Uses a shared semaphore for global concurrency control across all roots.
 * @param {import('../lib/semaphore.js').Semaphore} semaphore - shared across all parallel roots
 */
export async function crawlRoot(db, dataDir, rateLimiter, rootSlug, logger, onProgress, opts = {}) {
  const { retryFailed = false, semaphore, adapter = null } = opts
  const root = db.getRootBySlug(rootSlug)
  if (!root) throw new NotFoundError(rootSlug, `Unknown root: ${rootSlug}`)

  // Seed the crawl queue with the root's entry point
  const seedPath = root.seed_path ?? rootSlug
  db.seedCrawlIfNew(seedPath, rootSlug, 0)

  // Optionally retry previously failed pages
  if (retryFailed) {
    const failedCount = db.countFailed(rootSlug)
    if (failedCount > 0) {
      db.resetFailedCrawl(rootSlug)
      logger.info(`Reset ${failedCount} failed pages for ${rootSlug} to pending`)
    }
  }

  // Concurrency for this root — pull more than we can run so the semaphore
  // always has work to schedule.
  const workerCount = semaphore ? semaphore.max : (opts.concurrency ?? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '5', 10))
  let processed = 0

  // Refill worker pool instead of batch barriers: the old shape awaited
  // Promise.allSettled per 500-page batch, so one page burning the retry
  // ladder (up to 60 s on Retry-After) stalled dispatch of the entire next
  // batch — a convoy that cost 15-30% of cold-crawl wall clock. Workers now
  // pull independently from a shared queue that refills from crawl_state
  // whenever it drains; `inFlight` keeps a refill from re-issuing rows whose
  // status hasn't flipped yet. Single-process ownership per root means no DB
  // claim is needed.
  let queue = []
  let cursor = 0
  // Paths taken from crawl_state but not yet completed (queued or in
  // flight): a refill must not re-issue them — their crawl_state row is
  // still 'pending' until processPage flips it at the end.
  const pendingLocal = new Set()
  let inFlightCount = 0
  let sinceProgress = 0

  const refill = () => {
    const rows = db.getPendingCrawl(rootSlug, Math.max(workerCount * 2, 32))
    for (const row of rows) {
      if (pendingLocal.has(row.path)) continue
      pendingLocal.add(row.path)
      queue.push(row)
    }
    // Compact the consumed prefix so a large root doesn't accumulate an
    // ever-growing array behind the cursor.
    if (cursor > 4096) {
      queue = queue.slice(cursor)
      cursor = 0
    }
  }

  const handleFailure = (path, reason) => {
    // Upstream 404 / 403 churn dominates a cold-corpus crawl: Apple's
    // parent pages list dictionary-key children that aren't served as
    // standalone URLs, plus a few deprecated selectors that 403
    // consistently. The doctor pass cleans these via parent re-resolution,
    // so demote to debug — the failed-state row is the canonical record.
    const message = reason?.message ?? ''
    const isUpstreamMiss = message.startsWith('Not found:') || message.startsWith('HTTP 403')
    const log = isUpstreamMiss ? logger.debug : logger.warn
    log.call(logger, `Failed: ${path}`, { error: message })
  }

  const worker = async () => {
    while (true) {
      if (cursor >= queue.length) {
        refill()
        if (cursor >= queue.length) {
          // Nothing pending — but a sibling's in-flight page may still seed
          // new references. Only exit once the whole pool is idle.
          if (inFlightCount === 0) return
          await new Promise(resolve => setTimeout(resolve, 25))
          continue
        }
      }
      const { path, depth } = queue[cursor++]
      inFlightCount++
      try {
        const run = () => processPage(db, dataDir, rateLimiter, root.id, rootSlug, root.source_type, path, depth, logger, adapter)
        await (semaphore ? semaphore.run(run) : run())
        processed++
      } catch (reason) {
        handleFailure(path, reason)
      } finally {
        inFlightCount--
        pendingLocal.delete(path)
      }
      // Stats aggregate over crawl_state; once per ~250 completions is
      // plenty for progress display (the old shape ran it per batch).
      if (++sinceProgress >= 250) {
        sinceProgress = 0
        onProgress?.({ ...db.getCrawlStats(rootSlug), current: path })
      }
    }
  }

  refill()
  if (queue.length > 0) {
    // Spawn the full pool even when the initial queue is tiny (a cold crawl
    // starts from one seed row): idle workers wait on the in-flight check
    // and pick up the fan-out as references get seeded.
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    onProgress?.({ ...db.getCrawlStats(rootSlug), current: null })
  }

  db.updateRootPageCount(rootSlug)
  const finalStats = db.getCrawlStats(rootSlug)
  return { processed, total: finalStats.processed + finalStats.failed }
}

async function processPage(db, dataDir, rateLimiter, rootId, rootSlug, sourceType, path, depth, logger, adapter = null) {
  try {
    const fetched = adapter
      ? await adapter.fetch(path, { db, dataDir, rateLimiter, logger })
      : await fetchDocPage(path, rateLimiter)
    const json = fetched.payload ?? fetched.json
    const etag = fetched.etag ?? null
    const lastModified = fetched.lastModified ?? null
    const persisted = await persistFetchedDocPage({
      db,
      dataDir,
      rootId,
      path,
      sourceType: adapter?.constructor.type ?? sourceType ?? 'apple-docc',
      json,
      etag,
      lastModified,
    })

    // Extract and seed references
    const references = adapter
      ? adapter.extractReferences(path, json)
      : persisted.references
    for (const refPath of references) {
      const refRoot = extractRootSlug(refPath)
      if (refRoot === rootSlug) {
        db.seedCrawlIfNew(refPath, rootSlug, depth + 1)
      }
    }

    db.setCrawlState(path, 'processed', rootSlug, depth)
  } catch (e) {
    const errMsg = e.status === 404 ? 'Not found' : e.message
    db.setCrawlState(path, 'failed', rootSlug, depth, errMsg)
    throw e
  }
}
