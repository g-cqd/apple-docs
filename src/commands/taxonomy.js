// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * @typedef {object} TaxonomyArgs
 * @property {'kind'|'role'|'docKind'|'roleHeading'|'sourceType'} [field]
 * @property {boolean} [all]      Bypass the per-field cap.
 * @property {number} [limit]     Override the per-field cap (ignored when `all: true`).
 *
 * @typedef {object} TaxonomyEntry
 * @property {string|null} value
 * @property {number} count
 *
 * @typedef {{ kind?: TaxonomyEntry[], role?: TaxonomyEntry[], docKind?: TaxonomyEntry[], roleHeading?: TaxonomyEntry[], sourceType?: TaxonomyEntry[] } | { field: string, values: TaxonomyEntry[] }} TaxonomyResult
 *
 * Enumerate distinct taxonomy values across the corpus with counts.
 *
 * Default returns the top 20 values per field — the long tail of `kind`
 * (57 entries today) dominates response tokens but rarely informs
 * follow-up queries. Pass `all: true` to opt back into the full
 * distribution.
 *
 * @param {TaxonomyArgs} opts
 * @param {{ db }} ctx
 * @returns {Promise<TaxonomyResult>}
 */
const TAXONOMY_DEFAULT_LIMIT = 20

export async function taxonomy(opts, ctx) {
  const { db } = ctx
  const field = opts?.field ? String(opts.field).trim() : null
  const limit = opts?.all === true ? null : (opts?.limit ?? TAXONOMY_DEFAULT_LIMIT)

  const limitClause = limit == null ? '' : ` LIMIT ${Number.parseInt(limit, 10)}`
  const queries = {
    kind: `SELECT COALESCE(kind, '') AS value, COUNT(*) AS count FROM documents WHERE kind IS NOT NULL AND kind != '' GROUP BY kind ORDER BY count DESC, value ASC${limitClause}`,
    role: `SELECT COALESCE(role, '') AS value, COUNT(*) AS count FROM documents WHERE role IS NOT NULL AND role != '' GROUP BY role ORDER BY count DESC, value ASC${limitClause}`,
    docKind: `SELECT COALESCE(kind, '') AS value, COUNT(*) AS count FROM documents WHERE kind IS NOT NULL AND kind != '' GROUP BY kind ORDER BY count DESC, value ASC${limitClause}`,
    roleHeading: `SELECT COALESCE(role_heading, '') AS value, COUNT(*) AS count FROM documents WHERE role_heading IS NOT NULL AND role_heading != '' GROUP BY role_heading ORDER BY count DESC, value ASC${limitClause}`,
    sourceType: `SELECT COALESCE(source_type, '') AS value, COUNT(*) AS count FROM documents WHERE source_type IS NOT NULL AND source_type != '' GROUP BY source_type ORDER BY count DESC, value ASC${limitClause}`,
  }

  const run = (sql) => {
    try {
      return db.db.query(sql).all()
    } catch {
      return []
    }
  }

  if (field && queries[field]) {
    return { field, values: run(queries[field]) }
  }

  return {
    kind: run(queries.kind),
    role: run(queries.role),
    docKind: run(queries.docKind),
    roleHeading: run(queries.roleHeading),
    sourceType: run(queries.sourceType),
  }
}
