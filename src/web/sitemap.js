import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ensureDir } from '../storage/files.js'

/**
 * Maximum URLs per <urlset> per the sitemap spec. Apple's biggest framework
 * (kernel, ~39 K docs) is well under this; we keep the constant explicit so
 * a future split-by-letter pass has somewhere obvious to hook.
 */
const URLS_PER_SITEMAP = 50_000

/**
 * Per-source-type defaults. `priority` is relative within the site (Google
 * normalises to [0, 1]); `changefreq` is a hint, not a contract — Google
 * mostly ignores it and uses lastmod, but Bing still honours it.
 */
const KIND_DEFAULTS = {
  framework: { priority: 0.8, changefreq: 'weekly' },
  tooling: { priority: 0.7, changefreq: 'monthly' },
  guidelines: { priority: 0.7, changefreq: 'monthly' },
  collection: { priority: 0.6, changefreq: 'weekly' },
  design: { priority: 0.7, changefreq: 'monthly' },
  'release-notes': { priority: 0.7, changefreq: 'weekly' },
  technology: { priority: 0.6, changefreq: 'monthly' },
}
const ROLE_NOTES_HINT = /release-notes/i
const DOC_DEFAULT = { priority: 0.6, changefreq: 'monthly' }

/** Escape a string for safe inclusion in XML text and attribute contexts. */
function escapeXml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Render one `<url>` block. Pulled out so the per-framework sitemap and the
 * homepage entry share the same shape and indentation.
 */
function urlEntry({ loc, lastmod, changefreq, priority }) {
  const parts = [`  <url>`, `    <loc>${escapeXml(loc)}</loc>`]
  if (lastmod) parts.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`)
  if (changefreq) parts.push(`    <changefreq>${escapeXml(changefreq)}</changefreq>`)
  if (priority != null) parts.push(`    <priority>${priority.toFixed(1)}</priority>`)
  parts.push(`  </url>`)
  return parts.join('\n')
}

/**
 * Produce the urlset XML for a single framework. Returns `null` if the
 * framework has no documents (caller skips).
 */
function buildFrameworkSitemapXml({ root, docs, baseUrl, lastmod }) {
  if (!docs || docs.length === 0) return null
  const kindDefaults = KIND_DEFAULTS[root.kind] ?? DOC_DEFAULT

  const entries = []
  // Framework landing page itself (one urlentry, slightly higher priority).
  entries.push(urlEntry({
    loc: `${baseUrl}/docs/${root.slug}/`,
    lastmod,
    changefreq: kindDefaults.changefreq,
    priority: kindDefaults.priority,
  }))

  // Per-document entries. Cap at URLS_PER_SITEMAP — Apple's biggest framework
  // is ~39 K docs, well under the 50 K limit, so this should never trip in
  // practice. Surfaces a hard error if it ever does.
  if (docs.length + 1 > URLS_PER_SITEMAP) {
    throw new Error(
      `framework ${root.slug} has ${docs.length} docs — exceeds the per-sitemap cap (${URLS_PER_SITEMAP}); split-by-letter not implemented`
    )
  }

  for (const doc of docs) {
    const isReleaseNotes = root.kind === 'release-notes' || ROLE_NOTES_HINT.test(doc.role_heading ?? '')
    entries.push(urlEntry({
      loc: `${baseUrl}/docs/${doc.key}/`,
      lastmod,
      changefreq: isReleaseNotes ? 'weekly' : DOC_DEFAULT.changefreq,
      priority: DOC_DEFAULT.priority,
    }))
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries.join('\n'),
    '</urlset>',
    '',
  ].join('\n')
}

/**
 * Produce the top-level <sitemapindex> XML pointing at every per-framework
 * file. The homepage and search are inlined as a single tiny "_root" sitemap.
 */
function buildSitemapIndexXml({ baseUrl, frameworkSlugs, lastmod }) {
  const sitemaps = ['_root', ...frameworkSlugs].map(slug => {
    const path = slug === '_root' ? '/sitemaps/_root.xml.gz' : `/sitemaps/${slug}.xml.gz`
    return [
      '  <sitemap>',
      `    <loc>${escapeXml(baseUrl + path)}</loc>`,
      `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
      '  </sitemap>',
    ].join('\n')
  })
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    sitemaps.join('\n'),
    '</sitemapindex>',
    '',
  ].join('\n')
}

/**
 * Build the sitemap-index + per-framework gzipped sitemaps for the whole
 * corpus. Writes:
 *
 *   - `${outputDir}/sitemap.xml`               sitemap-index (uncompressed; some bots reject gzipped indexes)
 *   - `${outputDir}/sitemaps/_root.xml.gz`     homepage + search page
 *   - `${outputDir}/sitemaps/<slug>.xml.gz`    one per framework
 *
 * Returns metadata for the build manifest.
 *
 * @param {object} opts
 * @param {import('../storage/database.js').DocsDatabase} opts.db
 * @param {string} opts.outputDir   Absolute path to the static-build root.
 * @param {string} opts.baseUrl     Public base URL with no trailing slash.
 * @param {string} opts.buildDate   YYYY-MM-DD timestamp for `<lastmod>`.
 * @returns {Promise<{ totalUrls: number, sitemapsBuilt: number }>}
 */
export async function generateSitemaps({ db, outputDir, baseUrl, buildDate }) {
  const sitemapsDir = join(outputDir, 'sitemaps')
  ensureDir(sitemapsDir)

  const lastmod = buildDate
  const cleanBase = baseUrl.replace(/\/+$/, '')

  // _root sitemap: homepage + search page (and any other site-wide entries
  // we don't want to spread across the per-framework files).
  const rootEntries = [
    urlEntry({ loc: `${cleanBase}/`, lastmod, changefreq: 'daily', priority: 1.0 }),
    urlEntry({ loc: `${cleanBase}/search`, lastmod, changefreq: 'monthly', priority: 0.7 }),
  ]
  const rootXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    rootEntries.join('\n'),
    '</urlset>',
    '',
  ].join('\n')
  await Bun.write(join(sitemapsDir, '_root.xml.gz'), gzipSync(Buffer.from(rootXml)))

  // Per-framework sitemaps. We pull the framework + its docs in two queries
  // each (matching the build pipeline's chunked pattern) and skip empty
  // frameworks so we don't emit zero-URL files.
  const roots = db.getRoots()
  const writtenSlugs = []
  let totalUrls = rootEntries.length

  for (const root of roots) {
    const docs = db.db.query(
      'SELECT key, role_heading FROM documents WHERE framework = ? ORDER BY key'
    ).all(root.slug)
    if (docs.length === 0) continue

    const xml = buildFrameworkSitemapXml({ root, docs, baseUrl: cleanBase, lastmod })
    if (!xml) continue

    await Bun.write(join(sitemapsDir, `${root.slug}.xml.gz`), gzipSync(Buffer.from(xml)))
    writtenSlugs.push(root.slug)
    totalUrls += docs.length + 1
  }

  // Sitemap-index. Kept uncompressed so naive crawlers that don't follow
  // gzipped index files still discover the per-framework children.
  const indexXml = buildSitemapIndexXml({
    baseUrl: cleanBase,
    frameworkSlugs: writtenSlugs,
    lastmod,
  })
  await Bun.write(join(outputDir, 'sitemap.xml'), indexXml)

  return { totalUrls, sitemapsBuilt: writtenSlugs.length + 1 }
}
