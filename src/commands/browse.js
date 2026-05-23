import { NotFoundError, ValidationError } from '../lib/errors.js'

/**
 * @typedef {object} BrowseArgs
 * @property {string} framework   Framework slug (e.g. swiftui, design, app-store-review).
 * @property {string} [path]      Page path to drill into; omit to list framework root.
 * @property {number} [limit]     Max pages when listing a full framework (cap 200).
 *
 * @typedef {object} BrowsePageEntry
 * @property {string} path
 * @property {string|null} title
 * @property {string|null} kind
 * @property {string|null} [abstract]
 * @property {string|null} [section]
 *
 * @typedef {object} BrowseResult
 * @property {string} framework
 * @property {string} [slug]
 * @property {string} [kind]
 * @property {string} [path]
 * @property {string} [title]
 * @property {BrowsePageEntry[]} [pages]
 * @property {BrowsePageEntry[]} [children]
 * @property {number} [total]
 * @property {boolean} [limited]
 *
 * Browse the topic tree for a framework or subtree.
 *
 * @param {BrowseArgs} opts
 * @param {{ db }} ctx
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

  if (opts.path) {
    const page = db.getPage(opts.path)
    if (!page) throw new NotFoundError(opts.path, `Page not found: ${opts.path}`)

    const refs = db.getDocumentRelationships(page.path)
    return {
      framework: root.display_name,
      path: opts.path,
      title: page.title,
      children: refs.map(r => ({
        path: r.target_path,
        title: r.anchor_text,
        section: r.section,
      })),
    }
  }

  const allPages = db.getPagesByRoot(root.slug)
  const limit = opts.limit ? Math.max(Number.parseInt(opts.limit, 10), 1) : undefined
  const pages = limit ? allPages.slice(0, limit) : allPages
  return {
    framework: root.display_name,
    slug: root.slug,
    kind: root.kind,
    pages: pages.map(p => ({
      path: p.path,
      title: p.title,
      kind: p.role_heading ?? p.role,
      abstract: p.abstract,
    })),
    total: allPages.length,
    limited: limit ? limit < allPages.length : false,
  }
}
