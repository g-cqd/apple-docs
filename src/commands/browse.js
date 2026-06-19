import { NotFoundError, ValidationError } from '../lib/errors.js'

const WWDC_PATH_YEAR = /^wwdc\/wwdc(\d{4})-/

/**
 * @typedef {any} BrowseArgs
 * @property {string} framework   Framework slug (e.g. swiftui, design, app-store-review).
 * @property {string} [path]      Page path to drill into; omit to list framework root.
 * @property {number} [limit]     Max pages when listing a full framework (cap 200).
 * @property {number} [year]      WWDC only: list one year's sessions.
 *
 * @typedef {any} BrowsePageEntry
 * @property {string} path
 * @property {string|null} title
 * @property {string|null} kind
 * @property {string|null} [abstract]
 * @property {string|null} [section]
 *
 * @typedef {any} BrowseResult
 * @property {string} framework
 * @property {string} [slug]
 * @property {string} [kind]
 * @property {string} [path]
 * @property {string} [title]
 * @property {number} [year]
 * @property {Array<{ year: number, count: number }>} [groups]
 * @property {BrowsePageEntry[]} [pages]
 * @property {BrowsePageEntry[]} [children]
 * @property {number} [total]
 * @property {boolean} [limited]
 *
 * Browse the topic tree for a framework or subtree.
 *
 * The WWDC root gets a scope-aware shape: a bare `browse wwdc` returns
 * per-year groups with counts (2,800+ flat sessions are useless as a list);
 * `year` narrows to one year's sessions; an explicit `limit` opts back into
 * the flat list.
 *
 * @param {BrowseArgs} opts
 * @param {{ db: any }} ctx
 * @returns {Promise<BrowseResult>}
 * @throws {ValidationError} when `framework` is missing.
 * @throws {NotFoundError} when the framework slug or page path is unknown.
 */
export async function browse(opts, ctx) {
  const { db } = ctx
  const { framework } = opts

  if (!framework) {
    throw new ValidationError('framework is required', { field: 'framework' })
  }

  const root = db.resolveRoot(framework)
  if (!root) {
    throw new NotFoundError(framework, `Unknown framework: ${framework}`)
  }

  const isWwdc = root.source_type === 'wwdc'
  if (opts.year != null && !isWwdc) {
    throw new ValidationError('year only applies to the wwdc root', { field: 'year', value: opts.year })
  }

  if (opts.path) {
    const page = db.getPage(opts.path)
    if (!page) throw new NotFoundError(opts.path, `Page not found: ${opts.path}`)

    const refs = db.getDocumentRelationships(page.path)
    return {
      framework: root.display_name,
      path: opts.path,
      title: page.title,
      children: refs.map((/** @type {any} */ r) => ({
        path: r.target_path,
        title: r.anchor_text,
        section: r.section,
      })),
    }
  }

  let allPages = db.getPagesByRoot(root.slug)
  const year = opts.year != null ? Number.parseInt(String(opts.year), 10) : null

  if (isWwdc && year != null) {
    allPages = allPages.filter((/** @type {any} */ p) => p.path.startsWith(`wwdc/wwdc${year}-`))
    if (allPages.length === 0) {
      throw new NotFoundError(String(year), `No WWDC sessions indexed for ${year}`)
    }
  } else if (isWwdc && opts.limit == null) {
    const counts = new Map()
    for (const p of allPages) {
      const m = WWDC_PATH_YEAR.exec(p.path)
      if (m) counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1)
    }
    return {
      framework: root.display_name,
      slug: root.slug,
      kind: root.kind,
      groups: [...counts.entries()].sort((a, b) => b[0] - a[0]).map(([groupYear, count]) => ({ year: groupYear, count })),
      total: allPages.length,
    }
  }

  // `defaultLimit` bounds flat listings for callers that must keep
  // responses small (MCP) without forcing the grouped WWDC shape away.
  const limit = opts.limit ? Math.max(Number.parseInt(opts.limit, 10), 1) : (opts.defaultLimit ?? undefined)
  const pages = limit ? allPages.slice(0, limit) : allPages
  return {
    framework: root.display_name,
    slug: root.slug,
    kind: root.kind,
    ...(year != null ? { year } : {}),
    pages: pages.map((/** @type {any} */ p) => ({
      path: p.path,
      title: p.title,
      kind: p.role_heading ?? p.role,
      abstract: p.abstract,
    })),
    total: allPages.length,
    limited: limit ? limit < allPages.length : false,
  }
}
