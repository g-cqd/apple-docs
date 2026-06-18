/**
 * Xcode-docs enrichment phase. Runs BETWEEN convert and the index phase so
 * pages inserted from Xcode's offline Developer Documentation MobileAsset
 * flow through the normal body-index build, instead of needing the post-hoc
 * FTS repair the standalone script performs.
 *
 * Asset resolution policy:
 *   - explicit `assetDbPath` (tests / tooling) wins;
 *   - else a locally-installed Xcode asset when present;
 *   - else the CDN download, but only when APPLE_DOCS_ENRICH_FETCH=1
 *     (the snapshot workflow sets it; a local `sync` never silently
 *     downloads the ~650 MB asset);
 *   - else skip — non-fatal by design, the corpus is complete without it.
 */

import { runStep } from '../../lib/run-step.js'
import { enrichFromAsset, findDocumentationAssets } from '../../sources/mobileasset-docs.js'
import { fetchDocumentationAsset, resolveDownload } from '../../sources/mobileasset-fetch.js'

export async function runEnrichPhase({ db, logger, assetDbPath = null, findAssets = findDocumentationAssets }) {
  const resolveAssetDb = async () => {
    if (assetDbPath) return assetDbPath
    const local = findAssets()
    if (local.length > 0) {
      logger.info(`Enriching from local Xcode documentation asset (${local[0].docs.toLocaleString()} pages).`)
      return local[0].dbPath
    }
    if (process.env.APPLE_DOCS_ENRICH_FETCH !== '1') {
      logger.info('No local Xcode documentation asset — skipping enrichment (APPLE_DOCS_ENRICH_FETCH=1 enables the CDN download).')
      return null
    }
    const dl = await resolveDownload({})
    logger.info(`Fetching Xcode documentation asset [${dl.source}] ${dl.url}`)
    const fetched = await fetchDocumentationAsset({ ...dl, logger })
    logger.info(fetched.cached ? 'Asset already cached.' : 'Asset downloaded + verified.')
    return fetched.dbPath
  }

  const step = await runStep(
    'sync.enrich-xcode',
    async () => {
      const dbPath = await resolveAssetDb()
      if (!dbPath) return { skipped: true }
      return enrichFromAsset(db, dbPath, { apply: true, logger })
    },
    { logger },
  )

  return step.ok ? step.result : { skipped: true, error: step.error.message }
}
