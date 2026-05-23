/**
 * @typedef {object} FrameworksArgs
 * @property {string} [kind] Filter by kind: framework, technology, tooling, release-notes, tutorial, guidelines.
 *
 * @typedef {object} FrameworkRoot
 * @property {string} slug
 * @property {string} name
 * @property {string} kind
 * @property {string} status
 * @property {number} pageCount
 * @property {string|null} lastSeen
 *
 * @typedef {object} FrameworksResult
 * @property {FrameworkRoot[]} roots
 * @property {number} total
 *
 * List known documentation roots. Default returns all (no kind filter).
 *
 * @param {FrameworksArgs} opts
 * @param {{ db }} ctx
 * @returns {Promise<FrameworksResult>}
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
