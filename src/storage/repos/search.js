/**
 * Search repository: the four-variant query planner (FTS5 / title-exact /
 * trigram / body), the body-index maintenance ops, the fuzzy-trigram
 * candidate fetch, and the framework-synonym lookup.
 *
 * Trigram and body statements are guarded against snapshots that ship
 * without those tables; the corresponding methods return empty results
 * when the table is absent.
 *
 * Each search variant accepts the same filter bag (framework / kind /
 * language / sourceType / min{Ios,Macos,…}) — the SQL fragments are kept
 * identical across variants so the cascade in commands/search.js sees a
 * uniform row shape. The shared projection, filter predicates, and param
 * builder live in `./search-sql.js`.
 *
 * FTS5 parser errors, malformed user queries, and missing-table edge
 * cases return empty results so the cascade in commands/search.js can
 * fall through, but every failure goes through `safeCall(log:
 * 'warn-once')` so the first occurrence per label surfaces in the JSON
 * logger and operators can tell when the planner is silently degrading.
 */

import { safeCall } from '../../lib/safe-call.js'
import { encodeSectionContent, decodeSectionContent } from '../section-codec.js'
import { RESULT_COLUMNS, FILTER_PREDICATES, buildFilterParams } from './search-sql.js'

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
  // ORDER BY bm25 before LIMIT: without ranking, a broad substring
  // ("view") matches tens of thousands of titles and SQLite returns the
  // first $limit rows in FTS-cursor order — arbitrary docs, with the best
  // matches potentially cut off before the JS rerank ever sees them.
  const searchTrigramStmt = hasTrigramTable
    ? db.query(`
        SELECT ${RESULT_COLUMNS}
        FROM documents_trigram
        JOIN documents d ON documents_trigram.rowid = d.id
        LEFT JOIN roots r ON r.slug = d.framework
        WHERE documents_trigram MATCH $query
          ${FILTER_PREDICATES}
        ORDER BY bm25(documents_trigram)
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
  // Availability probe (§10(B)): LIMIT 1 stops at the first row; COUNT(*)
  // on this FTS5 index scans all 358k rows (~130ms warm, 43% of search CPU).
  const bodyExistsStmt = hasBodyFtsTable ? db.query('SELECT 1 FROM documents_body_fts LIMIT 1') : null
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
  // SQL-backed fuzzy candidate pre-filter. A per-worker in-memory
  // `Map<trigram, [docs]>` would build a ~7M-entry table (multi-hundred-
  // MB warm RSS per reader). The OR-of-trigrams MATCH query lets FTS5
  // rank titles by trigram overlap via bm25; Levenshtein then runs
  // main-thread on the resulting top-N candidates.
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

  // Semantic vectors (v22) + compressed raw payloads (v23). Both tables
  // are created by migrations that always run before this repo is built,
  // so the statements prepare unconditionally. An empty document_vectors
  // table simply means the semantic tier is dormant.
  const vectorCountStmt = db.query('SELECT COUNT(*) AS c FROM document_vectors')
  let vectorCountMemo // undefined = unread; busted by resetCountCache after a re-embed
  const allVectorsStmt = db.query('SELECT document_id, vec FROM document_vectors')
  const rawCountStmt = db.query('SELECT COUNT(*) AS c FROM document_raw')
  const rawUpsertStmt = db.query('INSERT OR REPLACE INTO document_raw(document_id, raw) VALUES (?, ?)')
  const rawByKeyStmt = db.query(`
    SELECT dr.raw AS raw
    FROM document_raw dr JOIN documents d ON d.id = dr.document_id
    WHERE d.key = ?
  `)

  return {
    hasTrigramTable,
    hasBodyFtsTable,
    /** Row count of the semantic vector table; 0 ⇒ tier dormant. Memoized
     *  (§10(B)): read per search, changes only at index time. */
    getVectorCount() {
      if (vectorCountMemo === undefined) {
        vectorCountMemo = safeCall(() => vectorCountStmt.get().c, { default: 0, log: 'warn-once', label: 'search.vectorCount' })
      }
      return vectorCountMemo
    },
    /** Bust the memoized vector count (after a re-embed). */
    resetCountCache() {
      vectorCountMemo = undefined
    },
    /** All packed binary codes: `[{ document_id, vec: Uint8Array }]`. */
    getAllVectors() {
      return safeCall(() => allVectorsStmt.all(), { default: [], log: 'warn-once', label: 'search.allVectors' })
    },
    /** Row count of the embedded raw-payload store. */
    getRawCount() {
      return safeCall(() => rawCountStmt.get().c, { default: 0, log: 'warn-once', label: 'search.rawCount' })
    },
    /** Store a raw Apple payload, zstd-compressed when that saves bytes. */
    upsertRawPayload(documentId, json) {
      if (json == null) return
      const text = typeof json === 'string' ? json : JSON.stringify(json)
      rawUpsertStmt.run(documentId, encodeSectionContent(text))
    },
    /** Fetch + inflate a raw payload by document key; null when absent. */
    getRawPayloadByKey(key) {
      const row = safeCall(() => rawByKeyStmt.get(key), { default: null, log: 'warn-once', label: 'search.rawByKey' })
      return row ? decodeSectionContent(row.raw) : null
    },
    /** Batched id→record fetch (semantic tier maps doc ids back to rows). */
    getSearchRecordsByIds(ids) {
      const safe = (ids ?? []).map(Number).filter(Number.isInteger)
      if (safe.length === 0) return []
      const placeholders = safe.map(() => '?').join(',')
      return db.query(`
        SELECT d.id, d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
               d.declaration_text as declaration, d.platforms_json as platforms,
               COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
               d.source_type as source_type, d.source_metadata as source_metadata,
               d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language,
               d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos
        FROM documents d LEFT JOIN roots r ON r.slug = d.framework
        WHERE d.id IN (${placeholders})
      `).all(...safe)
    },
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
    /** Cheap "is the body tier populated" boolean (§10(B)) — avoids the
     *  full-index COUNT(*); getBodyIndexCount stays for the actual count. */
    hasBodyIndex() {
      if (!bodyExistsStmt) return false
      return safeCall(() => bodyExistsStmt.get() != null, {
        default: false,
        log: 'warn-once',
        label: 'search.hasBodyIndex',
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
     * Fuzzy candidate pre-filter. `orQuery` is an FTS5 OR-of-trigrams
     * expression — e.g. `"vie" OR "iew"`. bm25 ordering puts the
     * highest-trigram-overlap titles first; the caller runs Levenshtein
     * on the result to verify edit distance.
     */
    fuzzyTrigramCandidates(orQuery, limit = 500) {
      if (!fuzzyCandidatesStmt) return []
      return safeCall(() => fuzzyCandidatesStmt.all({ $query: orQuery, $limit: limit }), {
        default: [],
        log: 'warn-once',
        label: 'search.fuzzyCandidates',
      })
    },
    /** Document frequency for each given trigram, via the fts5vocab
     *  companion (v30). Returns Map<trigram, docCount>; empty Map when the
     *  vocab table is absent (lite tier / pre-v30). The fuzzy tier uses it
     *  to OR only the rarest query trigrams instead of unioning enormous
     *  posting lists for common ones ("ion", "ing", …). */
    trigramDocCounts(terms) {
      if (!terms || terms.length === 0) return new Map()
      const hasVocab = !!db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'documents_trigram_vocab'")
        .get()
      if (!hasVocab) return new Map()
      const placeholders = terms.map(() => '?').join(',')
      return safeCall(() => {
        const rows = db
          .query(`SELECT term, doc FROM documents_trigram_vocab WHERE term IN (${placeholders})`)
          .all(...terms)
        return new Map(rows.map(row => [row.term, row.doc]))
      }, { default: new Map(), log: 'warn-once', label: 'search.trigramDocCounts' })
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
