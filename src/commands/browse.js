/**
 * Browse the topic tree for a framework or subtree.
 * @param {{ framework: string, path?: string }} opts
 * @param {{ db }} ctx
 */
export async function browse(opts, ctx) {
  const { db } = ctx
  const { framework } = opts

  if (!framework) {
    throw new Error('framework is required')
  }

  const root = db.resolveRoot(framework)
  if (!root) {
    throw new Error(`Unknown framework: ${framework}`)
  }

  if (opts.path) {
    const page = db.getPage(opts.path)
    if (!page) throw new Error(`Page not found: ${opts.path}`)

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
