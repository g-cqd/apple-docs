/**
 * Xcode-docs enrichment phase. Runs BETWEEN convert and the index phase so
 * pages inserted from Xcode's offline Developer Documentation MobileAsset
 * flow through the normal body-index build, instead of needing the post-hoc
 * FTS repair the standalone script performs.
 *
 * Asset resolution policy:
 *   - explicit `assetDbPath` (tests / tooling) wins;
 *   - else a locally-installed Xcode asset when present;
 *   - else the CDN download. The CLI enables it by default
 *     (--no-enrich-fetch opts out); programmatic callers that omit
 *     `enrichFetch` stay offline unless APPLE_DOCS_ENRICH_FETCH=1
 *     (the legacy env the snapshot workflow sets). The ~650 MB asset is
 *     content-addressed and cached, so repeat syncs don't re-download;
 *   - else skip — non-fatal by design, the corpus is complete without it.
 */

import { runStep } from '../../lib/run-step.js'
import { enrichFromAsset, findDocumentationAssets } from '../../sources/mobileasset-docs.js'
import { fetchDocumentationAsset, resolveDownload } from '../../sources/mobileasset-fetch.js'

export async function runEnrichPhase({ db, logger, assetDbPath = null, fullRebuild = false, enrichFetch, findAssets = findDocumentationAssets }) {
  const resolveAssetDb = async () => {
    if (assetDbPath) return assetDbPath
    const local = findAssets()
    if (local.length > 0) {
      logger.info(`Enriching from local Xcode documentation asset (${local[0].docs.toLocaleString()} pages).`)
      return local[0].dbPath
    }
    const allowFetch = enrichFetch ?? (process.env.APPLE_DOCS_ENRICH_FETCH === '1')
    if (!allowFetch) {
      logger.info('No local Xcode documentation asset — skipping enrichment (re-run without --no-enrich-fetch to allow the CDN download).')
      return null
    }
    const dl = await resolveDownload({})
    logger.info(`Fetching Xcode documentation asset [${dl.source}] ${dl.url}`)
    const fetched = await fetchDocumentationAsset({ ...dl, logger })
    logger.info(fetched.cached ? 'Asset already cached.' : 'Asset downloaded + verified.')
    return fetched.dbPath
  }

  const step = await runStep('sync.enrich-xcode', async () => {
    const dbPath = await resolveAssetDb()
    if (!dbPath) return { skipped: true }

    // The asset directory is content-addressed (<sha1>.asset), so an
    // unchanged path means an identical corpus — re-merging it scans and
    // JSON-parses all ~327k asset pages (~20 s) to change nothing. `--full`
    // still merges unconditionally so freshly recrawled pages get their USR
    // backfill even against an unchanged asset.
    const stampKey = 'xcode_enrich_asset'
    const stamp = db.db.query('SELECT value FROM schema_meta WHERE key = ?').get(stampKey)?.value ?? null
    if (!fullRebuild && stamp === dbPath) {
      logger.info('Xcode documentation asset unchanged since last merge — skipping enrichment')
      return { skipped: true, unchangedAsset: true }
    }

    const result = enrichFromAsset(db, dbPath, { apply: true, logger })
    db.db.run('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)', [stampKey, dbPath])
    return result
  }, { logger })

  return step.ok ? step.result : { skipped: true, error: step.error.message }
}
