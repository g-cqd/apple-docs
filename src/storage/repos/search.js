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
 *
 * P2.5 (silent-catch cleanup): FTS5 parser errors, malformed user queries,
 * and missing-table edge cases used to swallow exceptions and return
 * empty results without any signal. They still return empty results (the
 * cascade in commands/search.js relies on it), but every failure now
 * goes through safeCall(log: 'warn-once') so the first occurrence per
 * label surfaces in the JSON logger and operators can tell when the
 * planner is silently degrading.
 */

import { safeCall } from '../../lib/safe-call.js'
import { encodeVersion } from '../../lib/version-encode.js'

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
//
// P3.1: multi-source / year / track / deprecated now push down to SQL.
// The over-fetch multiplier in search.js drops from 10× to 3× when
// only `kind` and `platformFilters` remain JS-side.
const FILTER_PREDICATES = `
  AND ($framework IS NULL OR d.framework = $framework)
  AND ($source_type IS NULL OR d.source_type = $source_type)
  AND ($sources_json IS NULL OR d.source_type IN (SELECT value FROM json_each($sources_json)))
  AND (
    $kind IS NULL
    OR LOWER(COALESCE(d.role_heading, '')) = LOWER($kind)
    OR LOWER(COALESCE(d.kind, '')) = LOWER($kind)
    OR LOWER(COALESCE(d.role, '')) = LOWER($kind)
  )
  AND ($language IS NULL OR d.language IS NULL OR d.language = $language OR d.language = 'both')
  AND ($year IS NULL OR CAST(json_extract(d.source_metadata, '$.year') AS INTEGER) = $year)
  AND ($track_like IS NULL OR LOWER(COALESCE(json_extract(d.source_metadata, '$.track'), '')) LIKE $track_like)
  AND (
    $deprecated_mode = 'include'
    OR ($deprecated_mode = 'exclude' AND COALESCE(d.is_deprecated, 0) = 0)
    OR ($deprecated_mode = 'only'    AND COALESCE(d.is_deprecated, 0) = 1)
  )
  AND ($min_ios IS NULL OR d.min_ios_num IS NULL OR d.min_ios_num <= $min_ios)
  AND ($min_macos IS NULL OR d.min_macos_num IS NULL OR d.min_macos_num <= $min_macos)
  AND ($min_watchos IS NULL OR d.min_watchos_num IS NULL OR d.min_watchos_num <= $min_watchos)
  AND ($min_tvos IS NULL OR d.min_tvos_num IS NULL OR d.min_tvos_num <= $min_tvos)
  AND ($min_visionos IS NULL OR d.min_visionos_num IS NULL OR d.min_visionos_num <= $min_visionos)
`

function buildFilterParams({
  framework = null, kind = null, language = null, sourceType = null,
  sources = null, year = null, track = null, deprecatedMode = 'include',
  minIos = null, minMacos = null, minWatchos = null, minTvos = null, minVisionos = null,
} = {}) {
  // P3.1: pack multi-source as a JSON array string for json_each().
  // null → no filter; single-element list → equivalent to $source_type.
  const sourcesJson = Array.isArray(sources) && sources.length > 0
    ? JSON.stringify(sources)
    : (sources instanceof Set && sources.size > 0
      ? JSON.stringify([...sources])
      : null)
  // Track filter is substring-matched (lowercase) so "graphics" matches
  // "Graphics & Games". $track_like has the `%...%` wrappers baked in.
  const trackLike = typeof track === 'string' && track.trim()
    ? `%${track.trim().toLowerCase()}%`
    : null
  // Deprecated mode is one of 'include' | 'exclude' | 'only'. The
  // FILTER_PREDICATES OR chain selects which branch applies — pass
  // through verbatim with a safe fallback.
  const deprecated = ['include', 'exclude', 'only'].includes(deprecatedMode)
    ? deprecatedMode
    : 'include'
  return {
    $framework: framework,
    $kind: kind,
    $language: language,
    $source_type: sourceType,
    $sources_json: sourcesJson,
    $year: typeof year === 'number' && Number.isFinite(year) ? year : null,
    $track_like: trackLike,
    $deprecated_mode: deprecated,
    // v15a: filter predicates compare numeric companions; encode the
    // user-supplied "17.4"-style strings to integers up front so SQLite
    // doesn't collate text. encodeVersion('') / null both → null which
    // the predicate treats as "no filter".
    $min_ios: encodeVersion(minIos),
    $min_macos: encodeVersion(minMacos),
    $min_watchos: encodeVersion(minWatchos),
    $min_tvos: encodeVersion(minTvos),
    $min_visionos: encodeVersion(minVisionos),
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
  // P3.2: SQL-backed fuzzy candidate pre-filter. Replaces the
  // in-memory _trigramCache that built a ~7M-entry Map<trigram, [docs]>
  // per reader-worker (multi-hundred-MB warm RSS). The OR-of-trigrams
  // MATCH query lets FTS5 rank titles by trigram overlap via bm25;
  // Levenshtein runs main-thread on the resulting top-N candidates.
  const fuzzyCandidatesStmt = hasTrigramTable
    ? db.query(`
        SELECT d.id, d.title, bm25(documents_trigram) as score
        FROM documents_trigram
        JOIN documents d ON documents_trigram.rowid = d.id
        WHERE documents_trigram MATCH $query
        ORDER BY score
        LIMIT $limit
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
      return safeCall(
        () => searchTrigramStmt.all({
          $query: query,
          $limit: opts.limit ?? 100,
          ...buildFilterParams(opts),
        }),
        { default: [], log: 'warn-once', label: 'search.trigram' },
      )
    },
    searchBody(ftsQuery, opts = {}) {
      if (!searchBodyStmt) return []
      return safeCall(
        () => searchBodyStmt.all({
          $query: ftsQuery,
          $limit: opts.limit ?? 100,
          ...buildFilterParams(opts),
        }),
        { default: [], log: 'warn-once', label: 'search.body' },
      )
    },
    getBodyIndexCount() {
      if (!bodyCountStmt) return 0
      return safeCall(() => bodyCountStmt.get().c, {
        default: 0,
        log: 'warn-once',
        label: 'search.bodyIndexCount',
      })
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
      return safeCall(() => trigramCandidatesStmt.all({ $trigram: trigram }), {
        default: [],
        log: 'warn-once',
        label: 'search.trigramCandidates',
      })
    },
    /**
     * Fuzzy candidate pre-filter (P3.2). `orQuery` is an FTS5 OR-of-
     * trigrams expression — e.g. `"vie" OR "iew"`. bm25 ordering puts
     * the highest-trigram-overlap titles first; the caller runs
     * Levenshtein on the result to verify edit distance.
     */
    fuzzyTrigramCandidates(orQuery, limit = 500) {
      if (!fuzzyCandidatesStmt) return []
      return safeCall(() => fuzzyCandidatesStmt.all({ $query: orQuery, $limit: limit }), {
        default: [],
        log: 'warn-once',
        label: 'search.fuzzyCandidates',
      })
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
