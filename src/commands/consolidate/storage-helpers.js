import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeIdentifier } from '../../apple/normalizer.js'
import { stableStringify } from '../../storage/files.js'

/**
 * Storage-side helpers used by consolidate.
 * - isInvalidFailedPath: identifies failed crawl_state rows that should
 *   never be retried (fragments, dot-ops, etc).
 * - minifyDir: walks a directory tree minifying raw-JSON payloads in
 *   place — runs as the trailing pass of consolidate --minify.
 */

export function isInvalidFailedPath(path) {
  const renorm = normalizeIdentifier(path)
  return renorm === null || path.includes('#') || (renorm !== path && renorm !== null)
}

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

export function minifyDir(dirPath, logger) {
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
