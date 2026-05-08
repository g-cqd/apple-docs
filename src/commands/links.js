/**
 * `apple-docs links audit`        — scan every rendered HTML doc for `<a href>`
 *                                    targets, classify each, and report counts
 *                                    + top broken patterns.
 * `apple-docs links consolidate`  — re-apply the cross-source link resolver
 *                                    to the stored `document_sections.content_json`
 *                                    payloads. Migrates already-synced corpora
 *                                    so existing references gain `_resolvedKey`
 *                                    without re-fetching from origin.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { classifyLink, mapUrlToKey } from '../lib/link-resolver.js'

const HREF_REGEX = /<a\s[^>]*href\s*=\s*"([^"]+)"/gi

/**
 * Walk a directory tree and yield every regular file path.
 *
 * @param {string} root
 * @returns {AsyncGenerator<string>}
 */
async function* walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

/**
 * Extract every `<a href>` URL from an HTML string, attributed to the section
 * (article body, breadcrumb nav, sidebar aside) it appears in. Section
 * attribution is approximate — we match the most recent `<article|nav|aside>`
 * opening tag at each position.
 *
 * @param {string} html
 * @returns {Array<{ href: string, section: string }>}
 */
function extractLinks(html) {
  // Find each section open + close to slice into regions.
  const sections = []
  for (const m of html.matchAll(/<(article|nav|aside|header|footer)\b[^>]*?(?:class\s*=\s*"([^"]*)")?[^>]*>/gi)) {
    sections.push({
      tag: m[1].toLowerCase(),
      cls: (m[2] ?? '').toLowerCase(),
      start: m.index,
      end: html.length, // refined below
    })
  }
  // Sort by start, stamp end as next section's start (rough heuristic).
  sections.sort((a, b) => a.start - b.start)
  for (let i = 0; i < sections.length - 1; i++) {
    sections[i].end = sections[i + 1].start
  }

  const labelFor = (sec) => {
    if (!sec) return 'other'
    if (sec.cls.includes('breadcrumb')) return 'breadcrumb'
    if (sec.cls.includes('topics') || sec.cls.includes('see-also')) return 'related'
    if (sec.cls.includes('symbols-detail')) return 'sidebar'
    if (sec.tag === 'article') return 'article'
    if (sec.tag === 'aside') return 'sidebar'
    if (sec.tag === 'nav') return 'breadcrumb'
    if (sec.tag === 'header') return 'chrome'
    if (sec.tag === 'footer') return 'chrome'
    return sec.tag
  }

  const findSection = (pos) => {
    for (let i = sections.length - 1; i >= 0; i--) {
      if (sections[i].start <= pos && pos < sections[i].end) return sections[i]
    }
    return null
  }

  const links = []
  HREF_REGEX.lastIndex = 0
  for (const m of html.matchAll(HREF_REGEX)) {
    links.push({
      href: m[1],
      section: labelFor(findSection(m.index)),
    })
  }
  return links
}

/**
 * Walk built HTML files, classify every link, return aggregated stats.
 *
 * @param {object} opts
 * @param {string} opts.outDir Path to the built static site (e.g. dist/web).
 * @param {boolean} [opts.json] Return raw stats (otherwise default; consumed by formatter).
 * @param {{ db, logger }} ctx
 * @returns {Promise<object>}
 */
export async function linksAudit(opts, ctx) {
  const { db, logger } = ctx
  const outDir = opts.outDir ?? 'dist/web'

  if (!existsSync(outDir)) {
    throw new Error(`outDir does not exist: ${outDir}. Run \`apple-docs web build\` first.`)
  }

  // Build the knownKeys set from the DB. Includes every active page key
  // regardless of source type.
  const knownKeys = new Set(
    db.db.query("SELECT path FROM pages WHERE status != 'deleted'").all().map(r => r.path),
  )

  logger?.info?.(`Auditing ${outDir} against ${knownKeys.size} known keys...`)

  const stats = {
    filesScanned: 0,
    linksTotal: 0,
    bySection: Object.create(null),
    byCategory: Object.create(null),
    byCategoryAndSection: Object.create(null),
    // Top broken-internal candidates (key → count + sample source pages).
    brokenInternalKeys: new Map(),
    relativeBroken: new Map(),
    externalResolvable: new Map(),
  }

  const docsRoot = join(outDir, 'docs')
  if (!existsSync(docsRoot)) {
    throw new Error(`No /docs directory in ${outDir}; the build may have failed.`)
  }

  for await (const file of walkFiles(docsRoot)) {
    if (!file.endsWith('.html')) continue
    stats.filesScanned++
    const html = await readFile(file, 'utf8')
    const links = extractLinks(html)
    const fromPath = file.slice(outDir.length).replace(/\/index\.html$/, '/')

    for (const { href, section } of links) {
      stats.linksTotal++
      stats.bySection[section] = (stats.bySection[section] ?? 0) + 1
      const result = classifyLink(href, { knownKeys })
      stats.byCategory[result.category] = (stats.byCategory[result.category] ?? 0) + 1
      const ckey = `${result.category}/${section}`
      stats.byCategoryAndSection[ckey] = (stats.byCategoryAndSection[ckey] ?? 0) + 1

      if (result.category === 'internal_broken' && result.internalKey) {
        const entry = stats.brokenInternalKeys.get(result.internalKey) ?? { count: 0, sources: new Set() }
        entry.count++
        if (entry.sources.size < 5) entry.sources.add(fromPath)
        stats.brokenInternalKeys.set(result.internalKey, entry)
      } else if (result.category === 'relative_broken') {
        const entry = stats.relativeBroken.get(href) ?? { count: 0, sources: new Set() }
        entry.count++
        if (entry.sources.size < 5) entry.sources.add(fromPath)
        stats.relativeBroken.set(href, entry)
      } else if (result.category === 'external_resolvable' && result.internalKey) {
        const entry = stats.externalResolvable.get(result.internalKey) ?? { count: 0, sources: new Set() }
        entry.count++
        if (entry.sources.size < 5) entry.sources.add(fromPath)
        stats.externalResolvable.set(result.internalKey, entry)
      }
    }

    // Progress is reported per-file (not per-link) so the log line fires once
    // per chunk instead of once per link in that chunk.
    if (stats.filesScanned % 5000 === 0) {
      logger?.info?.(`  scanned ${stats.filesScanned} files, ${stats.linksTotal} links classified...`)
    }
  }

  const finalize = (m) => [...m.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 50)
    .map(([k, v]) => ({ value: k, count: v.count, sources: [...v.sources] }))

  return {
    filesScanned: stats.filesScanned,
    linksTotal: stats.linksTotal,
    bySection: stats.bySection,
    byCategory: stats.byCategory,
    byCategoryAndSection: stats.byCategoryAndSection,
    topBrokenInternal: finalize(stats.brokenInternalKeys),
    topRelativeBroken: finalize(stats.relativeBroken),
    topExternalResolvable: finalize(stats.externalResolvable),
  }
}

/**
 * Walk a content-node tree and rewrite `_resolvedKey` on `reference` and
 * `link` nodes whose destination URL maps to a corpus key. Validates the
 * candidate against the supplied `knownKeys` set; mismatches clear the
 * field so render-time falls back to the external destination.
 *
 * Mutates the input nodes in place and returns whether anything changed.
 *
 * @param {object} node
 * @param {Set<string>} knownKeys
 * @returns {{ added: number, removed: number, kept: number }}
 */
function consolidateNode(node, knownKeys) {
  const stats = { added: 0, removed: 0, kept: 0 }
  if (!node || typeof node !== 'object') return stats

  if (node.type === 'reference' && typeof node._resolvedKey === 'string') {
    if (!knownKeys.has(node._resolvedKey)) {
      delete node._resolvedKey
      stats.removed++
    } else {
      stats.kept++
    }
  }

  if (node.type === 'link') {
    const existing = node._resolvedKey
    let candidate = null
    if (typeof node.destination === 'string') {
      candidate = mapUrlToKey(node.destination)
    }
    if (candidate && knownKeys.has(candidate)) {
      if (existing !== candidate) {
        node._resolvedKey = candidate
        stats.added++
      } else {
        stats.kept++
      }
    } else if (existing) {
      delete node._resolvedKey
      stats.removed++
    }
  }

  // Same logic for `links` block items (each item carries its own _resolvedKey).
  if (node.type === 'links' && Array.isArray(node.items)) {
    for (const item of node.items) {
      if (typeof item._resolvedKey === 'string' && !knownKeys.has(item._resolvedKey)) {
        delete item._resolvedKey
        stats.removed++
      } else if (item._resolvedKey) {
        stats.kept++
      }
    }
  }

  // Recurse into the standard child arrays.
  for (const key of ['inlineContent', 'content']) {
    const arr = node[key]
    if (Array.isArray(arr)) {
      for (const child of arr) {
        const sub = consolidateNode(child, knownKeys)
        stats.added += sub.added
        stats.removed += sub.removed
        stats.kept += sub.kept
      }
    }
  }
  if (Array.isArray(node.items) && node.type !== 'links') {
    for (const item of node.items) {
      if (item?.content) {
        for (const child of item.content) {
          const sub = consolidateNode(child, knownKeys)
          stats.added += sub.added
          stats.removed += sub.removed
          stats.kept += sub.kept
        }
      }
    }
  }
  // termList items
  if (node.type === 'termList' && Array.isArray(node.items)) {
    for (const item of node.items) {
      const term = item?.term
      const def = item?.definition
      if (term?.inlineContent) {
        for (const child of term.inlineContent) {
          const sub = consolidateNode(child, knownKeys)
          stats.added += sub.added
          stats.removed += sub.removed
          stats.kept += sub.kept
        }
      }
      if (def?.content) {
        for (const child of def.content) {
          const sub = consolidateNode(child, knownKeys)
          stats.added += sub.added
          stats.removed += sub.removed
          stats.kept += sub.kept
        }
      }
    }
  }

  return stats
}

/**
 * Rewrite stored `document_sections.content_json` so every external URL that
 * maps to a corpus page gains a `_resolvedKey`, and stale entries are
 * scrubbed. Idempotent: re-running on already-consolidated data is a no-op.
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun]
 * @param {{ db, logger }} ctx
 * @returns {Promise<{ documentsScanned, sectionsTouched, _resolvedKeyAdded, _resolvedKeyRemoved, _resolvedKeyKept }>}
 */
export async function linksConsolidate(opts, ctx) {
  const { db, logger } = ctx
  const dryRun = opts.dryRun === true

  const knownKeys = new Set(
    db.db.query("SELECT path FROM pages WHERE status != 'deleted'").all().map(r => r.path),
  )
  logger?.info?.(`Consolidating links against ${knownKeys.size.toLocaleString('en-US')} corpus keys${dryRun ? ' (dry run)' : ''}...`)

  const sections = db.db.query(
    'SELECT id, document_id, content_json FROM document_sections WHERE content_json IS NOT NULL AND content_json != \'\''
  ).all()

  const totals = { documentsScanned: 0, sectionsTouched: 0, added: 0, removed: 0, kept: 0 }
  const docsTouched = new Set()
  const updateStmt = db.db.prepare('UPDATE document_sections SET content_json = ? WHERE id = ?')

  let processed = 0
  for (const row of sections) {
    let payload
    try { payload = JSON.parse(row.content_json) } catch { continue }
    if (!payload) continue

    let added = 0
    let removed = 0
    let kept = 0
    const visit = (node) => {
      const sub = consolidateNode(node, knownKeys)
      added += sub.added
      removed += sub.removed
      kept += sub.kept
    }

    if (Array.isArray(payload)) {
      for (const child of payload) visit(child)
    } else if (typeof payload === 'object') {
      visit(payload)
    }

    if (added + removed > 0) {
      totals.sectionsTouched++
      docsTouched.add(row.document_id)
      if (!dryRun) updateStmt.run(JSON.stringify(payload), row.id)
    }
    totals.added += added
    totals.removed += removed
    totals.kept += kept

    processed++
    if (processed % 50000 === 0) {
      logger?.info?.(`  scanned ${processed.toLocaleString('en-US')} sections — added ${totals.added.toLocaleString('en-US')}, removed ${totals.removed.toLocaleString('en-US')}`)
    }
  }

  totals.documentsScanned = docsTouched.size
  return totals
}
