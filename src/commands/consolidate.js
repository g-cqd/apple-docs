import { normalizeIdentifier, extractRootSlug } from '../apple/normalizer.js'
import { fetchDocPage } from '../apple/api.js'
import { extractMetadata, extractReferences } from '../apple/extractor.js'
import { renderPage } from '../apple/renderer.js'
import { sha256 } from '../lib/hash.js'
import { readJSON, writeJSON, writeText, stableStringify } from '../storage/files.js'
import { join } from 'node:path'
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'

/**
 * Consolidate command: analyze and fix failed crawl entries.
 *
 * 1. Cleans up entries that are now rejected by the updated normalizer (fragments, dot-ops)
 * 2. Re-resolves remaining failures by checking parent page references for correct URLs
 * 3. Retries re-resolved paths
 *
 * @param {{ dryRun?: boolean, minify?: boolean }} opts
 * @param {{ db, dataDir, rateLimiter, logger }} ctx
 */
export async function consolidate(opts, ctx) {
  const { db, dataDir, rateLimiter, logger } = ctx
  const dryRun = opts.dryRun ?? false

  db.setActivity('consolidate')

  const all = db.db.query("SELECT path, root_slug, error FROM crawl_state WHERE status = 'failed'").all()
  logger.info(`Analyzing ${all.length} failed entries...`)

  let cleaned = 0
  let resolved = 0
  let retried = 0
  let retriedOk = 0
  let genuine = 0
  const resolvedPaths = [] // { oldPath, newPath, root }

  // Phase 1: clean up entries that are not valid standalone pages
  for (const f of all) {
    const renorm = normalizeIdentifier(f.path)
    // Remove if: normalizer rejects it, path contains fragment, or normalized form differs (was mangled)
    const isInvalid = renorm === null || f.path.includes('#') || (renorm !== f.path && renorm !== null)
    if (isInvalid) {
      if (!dryRun) {
        db.db.run("DELETE FROM crawl_state WHERE path = ?", [f.path])
      }
      cleaned++
    }
  }
  logger.info(`Cleaned ${cleaned} invalid entries (fragments, dot-operators, bad URLs)`)

  // Phase 2: for remaining failures, check parent pages for correct URL
  const remaining = db.db.query("SELECT path, root_slug, error FROM crawl_state WHERE status = 'failed'").all()

  for (const f of remaining) {
    const segments = f.path.split('/')
    if (segments.length < 2) continue

    const parentPath = segments.slice(0, -1).join('/')

    // Read parent's raw JSON to find the correct reference URL
    const parentJson = await readJSON(join(dataDir, 'raw-json', parentPath + '.json'))
    if (!parentJson) continue

    const lastSeg = segments[segments.length - 1]

    // Search references for one whose identifier matches this failed path
    for (const [id, ref] of Object.entries(parentJson.references ?? {})) {
      const normId = normalizeIdentifier(id)
      if (normId !== f.path) continue

      // Found the reference — check if its url field gives a different path
      if (ref.url) {
        const urlPath = normalizeIdentifier(ref.url)
        if (urlPath && urlPath !== f.path) {
          resolvedPaths.push({ oldPath: f.path, newPath: urlPath, root: f.root_slug, title: ref.title })
          resolved++
          break
        }
      }
    }
  }

  logger.info(`Resolved ${resolved} paths to correct URLs`)

  // Phase 3: retry resolved paths (unless dry-run)
  if (!dryRun && resolvedPaths.length > 0) {
    logger.info(`Retrying ${resolvedPaths.length} resolved paths...`)

    for (const { oldPath, newPath, root } of resolvedPaths) {
      // Remove the old failed entry
      db.db.run("DELETE FROM crawl_state WHERE path = ?", [oldPath])

      // Check if the new path is already known
      const existing = db.getPage(newPath)
      if (existing) {
        retried++
        retriedOk++
        continue
      }

      // Fetch the correct URL
      try {
        const { json, etag, lastModified } = await fetchDocPage(newPath, rateLimiter)
        const jsonStr = await writeJSON(join(dataDir, 'raw-json', newPath + '.json'), json)
        const contentHash = sha256(jsonStr)
        const meta = extractMetadata(json)
        const rootSlug = extractRootSlug(newPath)
        const rootEntry = db.getRootBySlug(rootSlug ?? root)

        if (rootEntry) {
          db.upsertPage({
            rootId: rootEntry.id,
            path: newPath,
            url: `https://developer.apple.com/tutorials/data/documentation/${newPath}.json`,
            title: meta.title,
            role: meta.role,
            roleHeading: meta.roleHeading,
            abstract: meta.abstract,
            platforms: meta.platforms,
            declaration: meta.declaration,
            etag,
            lastModified,
            contentHash,
            downloadedAt: new Date().toISOString(),
          })

          // Convert to markdown
          try {
            const markdown = renderPage(json, newPath)
            await writeText(join(dataDir, 'markdown', newPath + '.md'), markdown)
            db.markConverted(newPath)
          } catch {}

          // Seed new references
          const refs = extractReferences(json)
          for (const refPath of refs) {
            const refRoot = extractRootSlug(refPath)
            if (refRoot === rootSlug) {
              db.seedCrawlIfNew(refPath, rootSlug, 0)
            }
          }
        }

        db.setCrawlState(newPath, 'processed', root, 0)
        retried++
        retriedOk++
      } catch (e) {
        db.setCrawlState(newPath, 'failed', root, 0, e.message)
        retried++
        logger.warn(`Retry failed: ${newPath}`, { error: e.message })
      }
    }
  }

  // Count what's left
  const stillFailed = db.db.query("SELECT COUNT(*) as c FROM crawl_state WHERE status = 'failed'").get().c

  // Phase 4: minify existing JSON files if requested
  let minified = 0
  let minifySaved = 0

  if (opts.minify && !dryRun) {
    const rawDir = join(dataDir, 'raw-json')
    logger.info('Minifying JSON files...')
    const result = minifyDir(rawDir, logger)
    minified = result.count
    minifySaved = result.saved
    logger.info(`Minified ${minified} files, saved ${(minifySaved / 1e6).toFixed(1)} MB`)
  }

  // Phase 5: rebuild body index if requested
  let bodyIndexed = 0
  if (opts.indexBody && !dryRun) {
    const { indexBodyFull } = await import('../pipeline/index-body.js')
    const idxResult = await indexBodyFull(db, dataDir, logger)
    bodyIndexed = idxResult.indexed
  }

  // Phase 6: verify snapshot integrity (if requested)
  let snapshotVerification = null
  if (opts.verify) {
    snapshotVerification = verifySnapshot(db, logger)
  }

  db.clearActivity()

  return {
    analyzed: all.length,
    cleaned,
    resolved,
    retried,
    retriedOk,
    genuine: stillFailed,
    minified,
    minifySaved,
    bodyIndexed,
    snapshotVerification,
    resolvedPaths: dryRun ? resolvedPaths : undefined,
    dryRun,
  }
}

function verifySnapshot(db, logger) {
  const tier = db.getSnapshotMeta('snapshot_tier')
  if (!tier) {
    return { installed: false, message: 'No snapshot found. Corpus was built locally.' }
  }

  const checks = []

  // Check 1: document count
  const expectedCount = parseInt(db.getSnapshotMeta('snapshot_document_count') ?? '0', 10)
  const actualCount = db.db.query('SELECT COUNT(*) as c FROM documents').get().c
  checks.push({
    name: 'document_count',
    expected: expectedCount,
    actual: actualCount,
    ok: actualCount >= expectedCount,
  })

  // Check 2: schema version
  const expectedSchema = parseInt(db.getSnapshotMeta('snapshot_schema_version') ?? '0', 10)
  const actualSchema = db.getSchemaVersion()
  checks.push({
    name: 'schema_version',
    expected: expectedSchema,
    actual: actualSchema,
    ok: actualSchema >= expectedSchema,
  })

  // Check 3: FTS integrity
  try {
    db.db.query("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')").run()
    checks.push({ name: 'fts_integrity', ok: true })
  } catch (e) {
    checks.push({ name: 'fts_integrity', ok: false, error: e.message })
  }

  const allOk = checks.every(c => c.ok)
  return {
    installed: true,
    tier,
    tag: db.getSnapshotMeta('snapshot_tag') ?? db.getSnapshotMeta('snapshot_version'),
    installedAt: db.getSnapshotMeta('snapshot_installed_at'),
    checks,
    ok: allOk,
  }
}

/**
 * Walk a directory and minify any JSON file that isn't already minified.
 * A file is considered not-minified if it contains a newline in the first 200 bytes.
 */
function minifyDir(dirPath, logger) {
  let count = 0
  let saved = 0

  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.endsWith('.json')) continue

      try {
        const raw = readFileSync(full)

        // Quick check: skip files that aren't actually JSON (e.g. Markdown/HTML from flat sources)
        const head = raw.subarray(0, Math.min(200, raw.length))
        const firstByte = head.length > 0 ? head[0] : 0
        if (firstByte !== 123 && firstByte !== 91) continue // 123 = '{', 91 = '['

        // Already minified if no newline in first 200 bytes
        if (!head.includes(10)) continue // 10 = '\n'

        const obj = JSON.parse(raw)
        const minStr = stableStringify(obj)
        const oldSize = raw.length
        const newSize = Buffer.byteLength(minStr)

        if (newSize < oldSize) {
          writeFileSync(full, minStr)
          saved += oldSize - newSize
          count++
        }
      } catch (e) {
        logger.warn(`Minify failed: ${full}`, { error: e.message })
      }

      if (count > 0 && count % 5000 === 0) {
        logger.info(`Minified ${count} files so far (${(saved / 1e6).toFixed(1)} MB saved)...`)
      }
    }
  }

  walk(dirPath)
  return { count, saved }
}
