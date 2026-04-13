import { fetchHtmlPage } from '../apple/api.js'
import { parseGuidelinesHtml, ROOT_SLUG, GUIDELINES_URL } from '../apple/guidelines-parser.js'
import { toFrontMatter } from '../lib/yaml.js'
import { sha256 } from '../lib/hash.js'
import { writeText } from '../storage/files.js'
import { join } from 'node:path'

/**
 * Sync the App Store Review Guidelines from Apple's website.
 * Fetches the HTML page, parses it into sections, and stores them
 * in the same format as DocC documentation (DB + Markdown files).
 *
 * @param {{ db: import('../storage/database.js').DocsDatabase, dataDir: string, rateLimiter: import('../lib/rate-limiter.js').RateLimiter, logger: object }} ctx
 * @returns {{ sections: number, lastUpdated: string|null }}
 */
export async function syncGuidelines(db, dataDir, rateLimiter, logger) {
  logger.info('Fetching App Store Review Guidelines...')
  const { html, etag, lastModified } = await fetchHtmlPage(GUIDELINES_URL, rateLimiter)

  logger.info('Parsing guidelines HTML...')
  const { sections, lastUpdated } = await parseGuidelinesHtml(html)
  logger.info(`Parsed ${sections.length} guideline sections (last updated: ${lastUpdated ?? 'unknown'})`)

  // Ensure root exists
  const root = db.upsertRoot(ROOT_SLUG, 'App Store Review Guidelines', 'guidelines', 'html-scrape')
  const rootId = root.id

  const contentHash = sha256(html)
  const now = new Date().toISOString()

  // Save raw HTML for reference
  await writeText(join(dataDir, 'raw-json', `${ROOT_SLUG}.html`), html)

  // Process each section
  for (const section of sections) {
    // Build Markdown with YAML front matter (same format as DocC pages)
    const fm = {
      title: section.title,
      framework: 'App Store Review Guidelines',
      role: section.role,
      role_heading: section.roleHeading,
      path: section.path,
      notarization: section.notarization || undefined,
      last_updated: lastUpdated || undefined,
    }
    const markdown = toFrontMatter(fm) + '\n\n' + section.markdown + '\n'

    // Write Markdown file
    await writeText(join(dataDir, 'markdown', section.path + '.md'), markdown)

    // Upsert page in DB
    const page = db.upsertPage({
      rootId,
      path: section.path,
      url: `${GUIDELINES_URL}#${section.id}`,
      title: section.title,
      role: section.role,
      roleHeading: section.roleHeading,
      abstract: section.abstract,
      platforms: null,
      declaration: null,
      etag,
      lastModified,
      contentHash,
      downloadedAt: now,
    })

    db.markConverted(section.path)

    // Add parent→child refs for browse support
    if (page && section.children.length > 0) {
      db.deleteRefsBySource(page.id)
      for (const childPath of section.children) {
        const child = sections.find(s => s.path === childPath)
        if (child) {
          db.addRef(page.id, childPath, child.title, 'Topics')
        }
      }
    }
  }

  db.updateRootPageCount(ROOT_SLUG)

  logger.info(`Synced ${sections.length} guideline sections`)
  return { sections: sections.length, lastUpdated }
}
