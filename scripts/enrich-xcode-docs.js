#!/usr/bin/env bun
/**
 * Merge Xcode's offline Developer Documentation MobileAsset into the local
 * corpus — USR + platform backfill on the keyed overlap, plus truly-novel
 * pages. Duplication-safe and idempotent (see sources/mobileasset-docs.js).
 *
 * Asset resolution is automatic: a locally-installed Xcode asset is used when
 * present, otherwise the asset is downloaded from Apple's CDN — so it works on
 * a GitHub Actions runner with no Xcode (the snapshot build relies on this).
 * Dry-run by default; nothing is written without --apply.
 *
 *   bun scripts/enrich-xcode-docs.js              # auto-resolve, report only
 *   bun scripts/enrich-xcode-docs.js --apply      # auto-resolve, write the merge
 *   bun scripts/enrich-xcode-docs.js --fetch --apply   # force CDN download
 *   bun scripts/enrich-xcode-docs.js --no-fetch        # local asset only
 *   bun scripts/enrich-xcode-docs.js --asset <index.sql>   # explicit DB
 *   bun scripts/enrich-xcode-docs.js --url <zip-url>       # explicit download
 *
 * Missing asset is non-fatal (warn + skip, exit 0) so a weekly snapshot never
 * breaks on a stale pin; pass --require to make absence a hard error.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../src/storage/database.js'
import { createLogger } from '../src/lib/logger.js'
import { enrichFromAsset, findDocumentationAssets } from '../src/sources/mobileasset-docs.js'
import { fetchDocumentationAsset, resolveDownload } from '../src/sources/mobileasset-fetch.js'

const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const flagValue = (name) => {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : null
}

const logger = createLogger('info')
const dataDir = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')

async function resolveAssetDbPath() {
  const explicit = flagValue('--asset')
  if (explicit) return explicit
  // Local-first unless --fetch forces a download. The runner has no Xcode, so
  // the local lookup yields nothing there and we fall through to the CDN.
  if (!args.has('--fetch')) {
    const local = findDocumentationAssets()
    if (local.length > 0) {
      logger.info(`Using local Xcode asset (${local[0].docs.toLocaleString()} pages).`)
      return local[0].dbPath
    }
  }
  if (args.has('--no-fetch')) return null
  try {
    const dl = await resolveDownload({ url: flagValue('--url') })
    logger.info(`Fetching documentation asset [${dl.source}] ${dl.url}`)
    const fetched = await fetchDocumentationAsset({ ...dl, logger })
    logger.info(fetched.cached ? 'Asset already cached.' : 'Asset downloaded + verified.')
    return fetched.dbPath
  } catch (err) {
    logger.warn(`Could not obtain the documentation asset by download: ${err.message}`)
    return null
  }
}

const dbPath = await resolveAssetDbPath()
if (!dbPath) {
  const msg = 'No Xcode Developer Documentation asset available (no local install; download unavailable).'
  if (args.has('--require')) { logger.error(msg); process.exit(2) }
  logger.warn(`${msg} Skipping enrichment.`)
  console.log(JSON.stringify({ apply, asset: null, skipped: true }))
  process.exit(0)
}

const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
try {
  const stats = enrichFromAsset(db, dbPath, { apply, logger })
  console.log(JSON.stringify({ apply, asset: dbPath, ...stats }, null, 2))
  if (!apply) logger.info('Dry-run only — re-run with --apply to write the merge.')
} finally {
  db.close()
}
