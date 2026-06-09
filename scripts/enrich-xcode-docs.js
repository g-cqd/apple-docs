#!/usr/bin/env bun
/**
 * Merge Xcode's offline Developer Documentation MobileAsset into the local
 * corpus — USR + platform backfill on the keyed overlap, plus truly-novel
 * pages. Duplication-safe and idempotent (see sources/mobileasset-docs.js).
 *
 * Dry-run by default; nothing is written without --apply.
 *
 *   bun scripts/enrich-xcode-docs.js              # report what would change
 *   bun scripts/enrich-xcode-docs.js --apply      # write the merge
 *   bun scripts/enrich-xcode-docs.js --asset <path-to-index.sql>
 *   bun scripts/enrich-xcode-docs.js --fetch      # no Xcode: download from
 *                                                 # Apple's CDN (local manifest
 *                                                 # URL, else pinned fallback)
 *   bun scripts/enrich-xcode-docs.js --fetch --url <zip-url>
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
const assetOverride = flagValue('--asset')

const logger = createLogger('info')
const dataDir = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')

let dbPath = assetOverride
if (!dbPath && args.has('--fetch')) {
  const dl = await resolveDownload({ url: flagValue('--url') })
  logger.info(`Fetching documentation asset [${dl.source}] ${dl.url}`)
  const fetched = await fetchDocumentationAsset({ ...dl, logger })
  logger.info(fetched.cached ? 'Asset already cached.' : 'Asset downloaded + verified.')
  dbPath = fetched.dbPath
}
if (!dbPath) {
  const assets = findDocumentationAssets()
  if (assets.length === 0) {
    logger.error('No Xcode Developer Documentation asset found. Install it via Xcode ▸ Settings ▸ Components, or pass --fetch.')
    process.exit(2)
  }
  logger.info(`Found ${assets.length} documentation asset(s); using the largest (${assets[0].docs.toLocaleString()} pages).`)
  dbPath = assets[0].dbPath
}

const db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
try {
  const stats = enrichFromAsset(db, dbPath, { apply, logger })
  console.log(JSON.stringify({ apply, asset: dbPath, ...stats }, null, 2))
  if (!apply) logger.info('Dry-run only — re-run with --apply to write the merge.')
} finally {
  db.close()
}
