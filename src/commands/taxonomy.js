/**
 * Enumerate distinct taxonomy values across the corpus with counts.
 *
 * Used by the `apple-docs kinds` CLI subcommand and the `list_taxonomy` MCP
 * tool so users and LLMs can discover valid --kind / --source values.
 *
 * @param {{ field?: string }} opts
 * @param {{ db }} ctx
 * @returns {{ kind, role, docKind, roleHeading, sourceType } | Array}
 */
export async function taxonomy(opts, ctx) {
  const { db } = ctx
  const field = opts?.field ? String(opts.field).trim() : null

  const queries = {
    kind: "SELECT COALESCE(kind, '') AS value, COUNT(*) AS count FROM documents WHERE kind IS NOT NULL AND kind != '' GROUP BY kind ORDER BY count DESC, value ASC",
    role: "SELECT COALESCE(role, '') AS value, COUNT(*) AS count FROM documents WHERE role IS NOT NULL AND role != '' GROUP BY role ORDER BY count DESC, value ASC",
    docKind: "SELECT COALESCE(kind, '') AS value, COUNT(*) AS count FROM documents WHERE kind IS NOT NULL AND kind != '' GROUP BY kind ORDER BY count DESC, value ASC",
    roleHeading: "SELECT COALESCE(role_heading, '') AS value, COUNT(*) AS count FROM documents WHERE role_heading IS NOT NULL AND role_heading != '' GROUP BY role_heading ORDER BY count DESC, value ASC",
    sourceType: "SELECT COALESCE(source_type, '') AS value, COUNT(*) AS count FROM documents WHERE source_type IS NOT NULL AND source_type != '' GROUP BY source_type ORDER BY count DESC, value ASC",
  }

  const run = (sql) => {
    try { return db.db.query(sql).all() } catch { return [] }
  }

  const all = {
    kind: run(queries.kind),
    role: run(queries.role),
    docKind: run(queries.docKind),
    roleHeading: run(queries.roleHeading),
    sourceType: run(queries.sourceType),
  }

  if (field && queries[field]) {
    return { field, values: all[field] }
  }
  return all
}
