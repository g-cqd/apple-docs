// The searchPages read op. Runs the FTS5 main planner statement against a
// handle's connection and frames the rows.
//
// The SQL below is the fully-interpolated FTS planner statement
// (RESULT_COLUMNS + bm25 + tier CASE + FILTER_PREDICATES). It MUST stay
// semantically identical to the parity test's reference — the test fails if
// it drifts. Result columns, in order (positional map):
//   path, title, role, role_heading, abstract, declaration, platforms,
//   min_ios, min_macos, min_watchos, min_tvos, min_visionos, framework,
//   root_slug, source_type, source_metadata, url_depth, is_release_notes,
//   is_deprecated, is_beta, doc_kind, language, rank, tier

/// Decoded `ad_storage_search_pages` request (filled by StorageExports).
public struct SearchPagesParams: Sendable {
  public var query: String
  public var raw: String
  public var limit: Int64
  public var framework: String?
  public var sourceType: String?
  public var sourcesJson: String?
  public var kind: String?
  public var language: String?
  public var year: Int64?
  public var trackLike: String?
  public var deprecatedMode: String
  public var minIos: Int64?
  public var minMacos: Int64?
  public var minWatchos: Int64?
  public var minTvos: Int64?
  public var minVisionos: Int64?

  public init(
    query: String, raw: String, limit: Int64, framework: String?, sourceType: String?,
    sourcesJson: String?, kind: String?, language: String?, year: Int64?, trackLike: String?,
    deprecatedMode: String, minIos: Int64?, minMacos: Int64?, minWatchos: Int64?, minTvos: Int64?,
    minVisionos: Int64?
  ) {
    self.query = query
    self.raw = raw
    self.limit = limit
    self.framework = framework
    self.sourceType = sourceType
    self.sourcesJson = sourcesJson
    self.kind = kind
    self.language = language
    self.year = year
    self.trackLike = trackLike
    self.deprecatedMode = deprecatedMode
    self.minIos = minIos
    self.minMacos = minMacos
    self.minWatchos = minWatchos
    self.minTvos = minTvos
    self.minVisionos = minVisionos
  }
}

public enum Storage {
  /// Opens a read connection for `path`; nil → fallback serves.
  public static func open(path: String) -> UInt64? {
    ConnectionRegistry.shared.open(path: path)
  }

  public static func close(_ handle: UInt64) {
    ConnectionRegistry.shared.close(handle)
  }

  /// Runs searchPages on `handle` and returns the framed row payload
  /// (`[u32 columnCount][u32 rowCount][rows…]`), or nil on any failure
  /// (unknown handle, prepare error, step error).
  public static func searchPages(handle: UInt64, _ params: SearchPagesParams) -> [UInt8]? {
    ConnectionRegistry.shared.withConnection(handle) { conn -> [UInt8]? in
      guard let stmt = conn.statement(searchPagesSQL) else { return nil }
      bindSearchPages(stmt, params)
      var out: [UInt8] = []
      out.reserveCapacity(4096)
      guard stmt.run(into: &out) else { return nil }
      return out
    } ?? nil
  }
}

/// Binds the 16 searchPages parameters. Shared by the FFI packed-binary path
/// (`Storage.searchPages`) and the in-process JSON path
/// (`StorageConnection.searchPagesJSON`).
func bindSearchPages(_ stmt: PreparedStatement, _ params: SearchPagesParams) {
  stmt.bind("$query", .text(params.query))
  stmt.bind("$raw", .text(params.raw))
  stmt.bind("$limit", .int(params.limit))
  stmt.bind("$framework", nullableText(params.framework))
  stmt.bind("$source_type", nullableText(params.sourceType))
  stmt.bind("$sources_json", nullableText(params.sourcesJson))
  stmt.bind("$kind", nullableText(params.kind))
  stmt.bind("$language", nullableText(params.language))
  stmt.bind("$year", nullableInt(params.year))
  stmt.bind("$track_like", nullableText(params.trackLike))
  stmt.bind("$deprecated_mode", .text(params.deprecatedMode))
  stmt.bind("$min_ios", nullableInt(params.minIos))
  stmt.bind("$min_macos", nullableInt(params.minMacos))
  stmt.bind("$min_watchos", nullableInt(params.minWatchos))
  stmt.bind("$min_tvos", nullableInt(params.minTvos))
  stmt.bind("$min_visionos", nullableInt(params.minVisionos))
}

private func nullableText(_ value: String?) -> BindValue {
  value.map { .text($0) } ?? .null
}

private func nullableInt(_ value: Int64?) -> BindValue {
  value.map { .int($0) } ?? .null
}

// The shared column projection + filter clauses (RESULT_COLUMNS +
// FILTER_PREDICATES), interpolated into each tier's statement below. Order is
// pinned — the cascade decodes rows positionally (SearchRow.decode).
let resultColumns = """
  d.key as path, d.title, d.role, d.role_heading, d.abstract_text as abstract,
  d.declaration_text as declaration, d.platforms_json as platforms,
  d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
  COALESCE(r.display_name, d.framework) as framework, COALESCE(r.slug, d.framework) as root_slug,
  d.source_type as source_type, d.source_metadata as source_metadata,
  d.url_depth, d.is_release_notes, d.is_deprecated, d.is_beta, d.kind as doc_kind, d.language
  """

let filterPredicates = """
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
  """

// MUST match the parity reference searchFtsStmt.
let searchPagesSQL = """
  SELECT
    \(resultColumns),
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
    \(filterPredicates)
  ORDER BY tier, rank
  LIMIT $limit
  """

// MUST match the parity reference searchTitleExactStmt (adds 0 as rank/tier; ORDER differs).
let searchTitleExactSQL = """
  SELECT \(resultColumns), 0 as rank, 0 as tier
  FROM documents d
  LEFT JOIN roots r ON r.slug = d.framework
  WHERE d.title = $raw COLLATE NOCASE
    \(filterPredicates)
  ORDER BY tier, CASE WHEN d.role = 'symbol' OR d.kind = 'symbol' THEN 0 ELSE 1 END, length(d.key)
  LIMIT $limit
  """

// MUST match the parity reference searchTrigramStmt (RESULT_COLUMNS only — no rank/tier).
let searchTrigramSQL = """
  SELECT \(resultColumns)
  FROM documents_trigram
  JOIN documents d ON documents_trigram.rowid = d.id
  LEFT JOIN roots r ON r.slug = d.framework
  WHERE documents_trigram MATCH $query
    \(filterPredicates)
  LIMIT $limit
  """

// MUST match the parity reference searchBodyStmt (RESULT_COLUMNS + a body bm25
// rank, no tier; the row decoder reads RESULT_COLUMNS only and ignores the
// trailing rank).
let searchBodySQL = """
  SELECT \(resultColumns),
    bm25(documents_body_fts, 1.0) as rank
  FROM documents_body_fts
  JOIN documents d ON documents_body_fts.rowid = d.id
  LEFT JOIN roots r ON r.slug = d.framework
  WHERE documents_body_fts MATCH $query
    \(filterPredicates)
  ORDER BY rank
  LIMIT $limit
  """
