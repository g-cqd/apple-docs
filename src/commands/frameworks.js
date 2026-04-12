/**
 * List known documentation roots.
 * @param {{ kind?: string }} opts
 * @param {{ db }} ctx
 */
export async function frameworks(opts, ctx) {
  const roots = ctx.db.getRoots(opts.kind ?? null)
  return {
    roots: roots.map(r => ({
      slug: r.slug,
      name: r.display_name,
      kind: r.kind,
      status: r.status,
      pageCount: r.page_count,
      lastSeen: r.last_seen,
    })),
    total: roots.length,
  }
}
