/**
 * Delayed retry of *transient* crawl failures.
 *
 * The crawl records each failed page with its upstream error string. Most are
 * permanent — 404 (Not found), 403 on dictionary-key children / deprecated
 * selectors — and must never be retried. A minority are transient: Apple's CDN
 * returns sporadic 5xx / 429 under load and those pages resolve fine moments
 * later. This sweep waits a reasonable backoff and re-fetches ONLY the
 * transient failures, a couple of rounds, so a momentary server hiccup doesn't
 * leave a page missing from the snapshot. A clean crawl (no transient failures)
 * pays no delay — the first probe returns an empty set and the sweep exits.
 */

import { fetchDocPage } from '../../apple/api.js'
import { persistFetchedDocPage } from '../../pipeline/persist.js'
import { pool } from '../../lib/pool.js'

// Retry HTTP 5xx, 408 (request timeout), 429 (rate limited), and
// transport-level failures; treat everything else (404/403/other 4xx) as
// permanent. Anchored on the error strings the crawl actually stores
// (e.g. "HTTP 503 fetching https://…", "fetch failed", "… timed out").
const TRANSIENT_RE =
  /\bHTTP (5\d{2}|408|429)\b|timed? ?out|timeout|fetch failed|unable to connect|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i

export function isTransientError(error) {
  return typeof error === 'string' && TRANSIENT_RE.test(error)
}

/**
 * @param {{ db, dataDir, rateLimiter, logger, semaphore? }} ctx
 * @param {{
 *   rounds?: number,
 *   baseDelayMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   fetchPage?: typeof fetchDocPage,
 *   persist?: typeof persistFetchedDocPage,
 * }} [opts] - sleep/fetchPage/persist are injectable so unit tests run offline.
 * @returns {Promise<{ recovered: number, rounds: number, remaining: number }>}
 */
export async function retryTransientFailures(ctx, opts = {}) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const rounds = opts.rounds ?? 2
  const baseDelayMs = opts.baseDelayMs ?? 30_000
  const sleep = opts.sleep ?? (ms => Bun.sleep(ms))
  const fetchPage = opts.fetchPage ?? fetchDocPage
  const persist = opts.persist ?? persistFetchedDocPage
  const concurrency = Math.max(1, ctx.semaphore?.max ?? Number.parseInt(process.env.APPLE_DOCS_CONCURRENCY ?? '5', 10))

  const transientFailures = () =>
    db.db
      .query("SELECT path, root_slug, error FROM crawl_state WHERE status = 'failed'")
      .all()
      .filter(row => isTransientError(row.error))

  let recovered = 0
  let roundsRun = 0
  for (let round = 1; round <= rounds; round++) {
    const transient = transientFailures()
    if (transient.length === 0) break
    roundsRun = round
    const delay = baseDelayMs * round
    logger?.info?.(
      `Transient-failure retry ${round}/${rounds}: ${transient.length} page(s) after ${Math.round(delay / 1000)}s backoff`,
    )
    await sleep(delay)

    await pool(transient, concurrency, async ({ path, root_slug }) => {
      const root = db.getRootBySlug(root_slug)
      if (!root) return
      try {
        const { json, etag, lastModified } = await fetchPage(path, rateLimiter)
        await persist({
          db,
          dataDir,
          rootId: root.id,
          path,
          sourceType: root.source_type ?? 'apple-docc',
          json,
          etag,
          lastModified,
        })
        db.setCrawlState(path, 'processed', root_slug, 0)
        recovered++
      } catch (error) {
        // Still failing — keep the row (its error may now be permanent).
        db.setCrawlState(path, 'failed', root_slug, 0, error.message)
      }
    })
  }

  if (recovered > 0) logger?.info?.(`Transient-failure retry recovered ${recovered} page(s)`)
  return { recovered, rounds: roundsRun, remaining: transientFailures().length }
}
