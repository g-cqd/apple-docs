import { ROOT_SLUG, GUIDELINES_URL } from '../apple/guidelines-parser.js'
import { normalize } from '../content/normalize.js'
import { toFrontMatter } from '../lib/yaml.js'
import { sha256 } from '../lib/hash.js'
import { stableStringify, writeText } from '../storage/files.js'
import { join } from 'node:path'

export async function applyGuidelinesSnapshot(db, dataDir, snapshot) {
  const {
    html,
    etag = null,
    lastModified = null,
    sections = [],
    lastUpdated = null,
  } = snapshot

  // Ensure root exists
  const root = db.upsertRoot(ROOT_SLUG, 'App Store Review Guidelines', 'guidelines', 'html-scrape')
  const rootId = root.id

  const contentHash = sha256(html)
  const now = new Date().toISOString()

  // Save raw HTML for reference
  await writeText(join(dataDir, 'raw-json', `${ROOT_SLUG}.html`), html)

  const currentPaths = new Set(sections.map(section => section.path))
  for (const existing of db.getPagesByRoot(ROOT_SLUG)) {
    if (!currentPaths.has(existing.path)) {
      db.markPageDeleted(existing.path)
    }
  }

  // Process each section
  for (const section of sections) {
    const normalized = normalize(section, section.path, 'guidelines')
    const doc = normalized.document
    const normalizedHash = sha256(stableStringify(normalized))

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
    const markdown = `${toFrontMatter(fm)}\n\n${section.markdown}\n`

    // Write Markdown file
    await writeText(join(dataDir, 'markdown', `${section.path}.md`), markdown)

    // Upsert page in DB
    const page = db.upsertPage({
      rootId,
      path: section.path,
      url: `${GUIDELINES_URL}#${section.id}`,
      title: doc.title,
      role: doc.role,
      roleHeading: doc.roleHeading,
      abstract: doc.abstractText,
      platforms: null,
      declaration: null,
      etag,
      lastModified,
      contentHash,
      downloadedAt: now,
      sourceType: doc.sourceType,
      language: doc.language,
      isReleaseNotes: doc.isReleaseNotes,
      urlDepth: doc.urlDepth,
      docKind: doc.kind,
      sourceMetadata: doc.sourceMetadata,
      skipDocumentSync: true,
    })
    db.upsertNormalizedDocument(normalized, {
      contentHash: normalizedHash,
      rawPayloadHash: contentHash,
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

  return { sections: sections.length, lastUpdated }
}
