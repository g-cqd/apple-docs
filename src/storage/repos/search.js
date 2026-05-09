/**
 * Search repository: the four-variant query planner (FTS5 / title-exact /
 * trigram / body), the body-index maintenance ops, the fuzzy-trigram
 * candidate fetch, and the framework-synonym lookup.
 *
 * Tier-aware: trigram and body statements are guarded against lite
 * snapshots that ship without those tables; the corresponding methods
 * return empty results when the table is absent.
 *
 * Each search variant accepts the same filter bag (framework / kind /
 * language / sourceType / min{Ios,Macos,…}) — the SQL fragments are kept
 * identical across variants so the cascade in commands/search.js sees a
 * uniform row shape.
 */

// Column projection shared across the four search variants. Bundled here
// so a future schema column addition only has to land in one place.
const RESULT_COLUMNS = `
  d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
  d.declaration_text as declaration, d.platforms_json as platforms,
  d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
  COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
  d.source_type as source_type, d.source_metadata as source_metadata,
  d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language
`

// Filter clauses appended to every variant after its specific MATCH/WHERE.
const FILTER_PREDICATES = `
  AND ($framework IS NULL OR d.framework = $framework)
  AND ($source_type IS NULL OR d.source_type = $source_type)
  AND (
    $kind IS NULL
    OR LOWER(COALESCE(d.role_heading, '')) = LOWER($kind)
    OR LOWER(COALESCE(d.kind, '')) = LOWER($kind)
    OR LOWER(COALESCE(d.role, '')) = LOWER($kind)
  )
  AND ($language IS NULL OR d.language IS NULL OR d.language = $language OR d.language = 'both')
  AND ($min_ios IS NULL OR d.min_ios IS NULL OR d.min_ios <= $min_ios)
  AND ($min_macos IS NULL OR d.min_macos IS NULL OR d.min_macos <= $min_macos)
  AND ($min_watchos IS NULL OR d.min_watchos IS NULL OR d.min_watchos <= $min_watchos)
  AND ($min_tvos IS NULL OR d.min_tvos IS NULL OR d.min_tvos <= $min_tvos)
  AND ($min_visionos IS NULL OR d.min_visionos IS NULL OR d.min_visionos <= $min_visionos)
`

function buildFilterParams({
  framework = null, kind = null, language = null, sourceType = null,
  minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null,
} = {}) {
  return {
    $framework: framework,
    $kind: kind,
    $language: language,
    $source_type: sourceType,
    $min_ios: minIos,
    $min_macos: minMacos,
    $min_watchos: minWatchos,
    $min_tvos: minTvos,
    $min_visionos: minVisionos,
  }
}

export function createSearchRepo(db, { hasTrigramTable = false, hasBodyFtsTable = false } = {}) {
  const searchFtsStmt = db.query(`
    SELECT ${RESULT_COLUMNS},
           bm25(documents_fts, 10.0, 5.0, 3.0, 2.0, 1.0) as rank,
           CASE
             WHEN LOWER(d.title) = LOWER($raw) THEN 0
             WHEN LOWER(d.key) = LOWER($raw) THEN 0
             WHEN LOWER(d.title) LIKE LOWER($raw) || '%' THEN 1
             WHEN INSTR(LOWER(d.title), LOWER($raw)) > 0 THEN 2
             ELSE 3
           END as tier
    FROM documents_fts
    JOIN documents d ON documents_fts.rowid = d.id
    LEFT JOIN roots r ON r.slug = d.framework
    WHERE documents_fts MATCH $query
      ${FILTER_PREDICATES}
    ORDER BY tier, rank
    LIMIT $limit
  `)
  const searchTitleExactStmt = db.query(`
    SELECT ${RESULT_COLUMNS}, 0 as rank, 0 as tier
    FROM documents d
    LEFT JOIN roots r ON r.slug = d.framework
    WHERE d.title = $raw COLLATE NOCASE
      ${FILTER_PREDICATES}
    ORDER BY tier, CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
    LIMIT $limit
  `)
  const searchTrigramStmt = hasTrigramTable
    ? db.query(`
        SELECT ${RESULT_COLUMNS}
        FROM documents_trigram
        JOIN documents d ON documents_trigram.rowid = d.id
        LEFT JOIN roots r ON r.slug = d.framework
        WHERE documents_trigram MATCH $query
          ${FILTER_PREDICATES}
        LIMIT $limit
      `)
    : null
  const searchBodyStmt = hasBodyFtsTable
    ? db.query(`
        SELECT ${RESULT_COLUMNS},
               bm25(documents_body_fts, 1.0) as rank
        FROM documents_body_fts
        JOIN documents d ON documents_body_fts.rowid = d.id
        LEFT JOIN roots r ON r.slug = d.framework
        WHERE documents_body_fts MATCH $query
          ${FILTER_PREDICATES}
        ORDER BY rank
        LIMIT $limit
      `)
    : null

  // Body-index maintenance
  const bodyCountStmt = hasBodyFtsTable ? db.query('SELECT COUNT(*) as c FROM documents_body_fts') : null
  const bodyInsertStmt = hasBodyFtsTable
    ? db.query('INSERT OR REPLACE INTO documents_body_fts(rowid, body) VALUES ($id, $body)')
    : null
  const bodyClearStmt = hasBodyFtsTable ? db.query('DELETE FROM documents_body_fts') : null
  const bodyDeleteByIdStmt = hasBodyFtsTable
    ? db.query('DELETE FROM documents_body_fts WHERE rowid = ?')
    : null

  // Fuzzy support
  const trigramCandidatesStmt = hasTrigramTable
    ? db.query(`
        SELECT d.id, d.title
        FROM documents_trigram
        JOIN documents d ON documents_trigram.rowid = d.id
        WHERE documents_trigram MATCH $trigram
      `)
    : null
  const allTitlesStmt = db.query('SELECT id, title FROM documents WHERE title IS NOT NULL')
  const searchByTitleStmt = db.query(`
    SELECT d.*, COALESCE(r.slug, d.framework) as root_slug, COALESCE(r.display_name, d.framework) as framework
    FROM documents d
    LEFT JOIN roots r ON r.slug = d.framework
    WHERE d.title = $title COLLATE NOCASE
      AND ($framework IS NULL OR d.framework = $framework)
    ORDER BY CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
    LIMIT 1
  `)
  const searchRecordByIdStmt = db.query(`
    SELECT d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
           d.declaration_text as declaration, d.platforms_json as platforms,
           COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
           d.source_type as source_type, d.source_metadata as source_metadata,
           d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language,
           d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos
    FROM documents d
    LEFT JOIN roots r ON r.slug = d.framework
    WHERE d.id = ?
  `)
  const frameworkSynonymsStmt = db.query(`
    SELECT alias FROM framework_synonyms WHERE canonical = ?
    UNION
    SELECT canonical FROM framework_synonyms WHERE alias = ?
  `)

  return {
    hasTrigramTable,
    hasBodyFtsTable,
    /** FTS5 main planner. Fires bm25-ranked rows tagged with a tier 0-3. */
    searchPages(ftsQuery, rawQuery, opts = {}) {
      return searchFtsStmt.all({
        $query: ftsQuery,
        $raw: rawQuery,
        $limit: opts.limit ?? 100,
        ...buildFilterParams(opts),
      })
    },
    /** Title-exact lookup (case-insensitive) — covers the FTS-misses case
     *  where the document title doesn't tokenize the way the FTS index
     *  does (e.g. dotted symbol names). Returns rows tagged tier=0. */
    searchTitleExact(rawQuery, opts = {}) {
      return searchTitleExactStmt.all({
        $raw: rawQuery,
        $limit: opts.limit ?? 100,
        ...buildFilterParams(opts),
      })
    },
    searchTrigram(query, opts = {}) {
      if (!searchTrigramStmt) return []
      try {
        return searchTrigramStmt.all({
          $query: query,
          $limit: opts.limit ?? 100,
          ...buildFilterParams(opts),
        })
      } catch {
        return []
      }
    },
    searchBody(ftsQuery, opts = {}) {
      if (!searchBodyStmt) return []
      try {
        return searchBodyStmt.all({
          $query: ftsQuery,
          $limit: opts.limit ?? 100,
          ...buildFilterParams(opts),
        })
      } catch {
        return []
      }
    },
    getBodyIndexCount() {
      if (!bodyCountStmt) return 0
      try { return bodyCountStmt.get().c } catch { return 0 }
    },
    insertBody(documentId, body) {
      bodyInsertStmt?.run({ $id: documentId, $body: body })
    },
    clearBodyIndex() {
      bodyClearStmt?.run()
    },
    deleteBodyByDocId(documentId) {
      bodyDeleteByIdStmt?.run(documentId)
    },
    getTrigramCandidates(trigram) {
      if (!trigramCandidatesStmt) return []
      try {
        return trigramCandidatesStmt.all({ $trigram: trigram })
      } catch {
        return []
      }
    },
    getAllTitles() {
      return allTitlesStmt.all()
    },
    searchByTitle(title, framework = null) {
      return searchByTitleStmt.get({ $title: title, $framework: framework })
    },
    getSearchRecordById(id) {
      return searchRecordByIdStmt.get(id)
    },
    /** Returns the symmetric synonym list for a framework slug (both
     *  directions: aliases pointing at slug + canonicals slug aliases at). */
    getFrameworkSynonyms(slug) {
      if (!slug) return []
      const normalized = slug.toLowerCase()
      return frameworkSynonymsStmt.all(normalized, normalized).map(r => r.alias ?? r.canonical)
    },
  }
}
