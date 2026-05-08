import { jsonResponse, API_CORPUS_CACHE_CONTROL } from '../responses.js'

/**
 * Returns the framework + role-heading drop-down options for the search
 * page. Pure DB read; the result is cacheable at the edge for the same
 * corpus stamp duration as `/api/search`.
 *
 * @type {import('../route-registry.js').RouteHandler}
 */
export function filtersHandler(_request, ctx) {
  const { db } = ctx
  const frameworks = db.db.query(
    `SELECT DISTINCT COALESCE(r.display_name, d.framework) as label, d.framework as value
     FROM documents d LEFT JOIN roots r ON r.slug = d.framework
     WHERE d.framework IS NOT NULL ORDER BY label`,
  ).all().map(r => ({ label: r.label, value: r.value }))
  const kinds = db.db.query(
    'SELECT DISTINCT role_heading FROM documents WHERE role_heading IS NOT NULL ORDER BY role_heading',
  ).all().map(r => r.role_heading)
  return jsonResponse(
    { frameworks, kinds },
    { headers: { 'Cache-Control': API_CORPUS_CACHE_CONTROL } },
  )
}
