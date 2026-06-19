/**
 * @typedef {any} FrameworksArgs
 * @property {string} [kind] Filter by kind: framework, technology, tooling, release-notes, tutorial, guidelines.
 *
 * @typedef {any} FrameworkRoot
 * @property {string} slug
 * @property {string} name
 * @property {string} kind
 * @property {string} status
 * @property {number} pageCount
 * @property {string|null} lastSeen
 *
 * @typedef {any} FrameworksResult
 * @property {FrameworkRoot[]} roots
 * @property {number} total
 *
 * List known documentation roots. Default returns all (no kind filter).
 *
 * @param {FrameworksArgs} opts
 * @param {{ db: any }} ctx
 * @returns {Promise<FrameworksResult>}
 */
export async function frameworks(opts, ctx) {
  // Live page counts (the stamped roots.page_count is only refreshed during
  // sync). Zero-page roots are catalog artifacts — Apple's root catalog
  // lists entries (Photos, Intents, Apple News API, ...) whose pages were
  // all crawled under a different umbrella root; listing them as browsable
  // roots is noise because browse returns nothing for them.
  const kind = opts.kind ?? null
  const roots = ctx.db.db
    .query(`
    SELECT r.*, COALESCE(c.n, 0) AS live_page_count
    FROM roots r
    LEFT JOIN (SELECT root_id, COUNT(*) AS n FROM pages WHERE status = 'active' GROUP BY root_id) c
      ON c.root_id = r.id
    WHERE COALESCE(c.n, 0) > 0 ${kind ? 'AND r.kind = $kind' : ''}
    ORDER BY r.slug
  `)
    .all(kind ? { $kind: kind } : {})
  return {
    roots: roots.map((/** @type {any} */ r) => ({
      slug: r.slug,
      name: r.display_name,
      kind: r.kind,
      status: r.status,
      pageCount: r.live_page_count,
      lastSeen: r.last_seen,
    })),
    total: roots.length,
  }
}
