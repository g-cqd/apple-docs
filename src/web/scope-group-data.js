/**
 * Data loader for scope groupings that need more than the page list.
 * Lives outside templates/ so the render layer stays pure — the docs
 * route and the static build both call this once per framework page.
 */

/**
 * HIG topics belong to category pages (Foundations, Patterns, the
 * Components subgroups, ...) via `child` document relationships; the
 * root landing page's own children give the canonical category order.
 * When one topic is referenced by several categories the most specific
 * (longest) parent path wins.
 *
 * @param {{ db: import('bun:sqlite').Database }} db DocsDatabase facade
 * @param {{ slug?: string, source_type?: string }} root
 * @returns {{ higGroups?: Map<string, { label: string, parentPath: string, order: number }> }}
 */
export function loadScopeExtras(db, root) {
  if (root?.slug !== 'design' && root?.source_type !== 'hig') return {}
  try {
    const rows = db.db
      .query(`
      SELECT dr.from_key AS parent, d.title AS parent_title, dr.to_key AS child
      FROM document_relationships dr
      JOIN documents d ON d.key = dr.from_key
      WHERE dr.relation_type = 'child' AND dr.from_key LIKE 'design/%'
    `)
      .all()
    const orderRows = db.db
      .query(`
      SELECT to_key FROM document_relationships
      WHERE from_key = 'design/human-interface-guidelines' AND relation_type = 'child'
      ORDER BY sort_order, to_key
    `)
      .all()
    const order = new Map(orderRows.map((r, i) => [r.to_key, i]))

    const higGroups = new Map()
    for (const row of rows) {
      if (row.parent === 'design/human-interface-guidelines') continue
      const existing = higGroups.get(row.child)
      if (existing && existing.parentPath.length >= row.parent.length) continue
      higGroups.set(row.child, {
        label: row.parent_title ?? row.parent,
        parentPath: row.parent,
        order: order.get(row.parent) ?? order.size + 1,
      })
    }
    return higGroups.size > 0 ? { higGroups } : {}
  } catch {
    return {}
  }
}
