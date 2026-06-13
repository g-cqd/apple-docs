// The in-process lexical search cascade (RFC 0001 P6). Orchestrates the three
// lexical tiers on ONE connection in ONE offload, merges (title-exact → FTS →
// trigram, dedup-by-path keep-first), reranks, slices, and projects to the
// public JSON envelope — byte-identical to JS
// projectSearchResult(search(opts,ctx)) for the lexical subset. Phase 1: no
// snippet/relatedCount enrichment, no kind/platform JS filters, no framework
// fan-out (single, no-filter query) — those land in follow-ons.

import ADStorage

public struct SearchParams: Sendable {
  public var query: String
  public var limit: Int
  public var offset: Int
  public init(query: String, limit: Int = 100, offset: Int = 0) {
    self.query = query
    self.limit = limit
    self.offset = offset
  }
}

/// A query prepared for tier execution — the per-tier params + the slice
/// bounds. nil from `prepare` means an empty query (emit `emptyEnvelope`).
public struct PreparedSearch: Sendable {
  public let q: String
  public let ftsParams: SearchPagesParams  // also used by title-exact (it ignores $query)
  public let trigramParams: SearchPagesParams
  public let limit: Int
  public let offset: Int
}

public enum Cascade {
  private static let tierLabels = ["exact", "prefix", "contains", "match"]

  /// The projected envelope for an empty query.
  public static let emptyEnvelope = Array(#"{"query":"","total":0,"results":[]}"#.utf8)

  /// Builds the per-tier params, or nil for an empty query. Pure — the caller
  /// runs the tiers (sequentially or in parallel) then calls `assemble`.
  public static func prepare(_ params: SearchParams) -> PreparedSearch? {
    let q = trimWS(params.query)
    if q.isEmpty { return nil }
    let limit = max(params.limit, 1)
    let offset = max(params.offset, 0)
    let requestedWindow = limit + offset
    // Phase 1: single query, no JS post-filters → searchLimit = requestedWindow,
    // no framework / source / kind / platform filters.
    let base = SearchPagesParams(
      query: FtsQuery.build(q), raw: q, limit: Int64(requestedWindow), framework: nil,
      sourceType: nil, sourcesJson: nil, kind: nil, language: nil, year: nil, trackLike: nil,
      deprecatedMode: "include", minIos: nil, minMacos: nil, minWatchos: nil, minTvos: nil,
      minVisionos: nil)
    var trigram = base
    trigram.query = FtsQuery.trigram(q)
    return PreparedSearch(q: q, ftsParams: base, trigramParams: trigram, limit: limit, offset: offset)
  }

  /// Runs the cascade on `conn` SEQUENTIALLY and returns the JSON envelope
  /// (convenience for tests; the server fans the tiers in parallel + calls
  /// `assemble`).
  public static func search(_ conn: StorageConnection, _ params: SearchParams) -> [UInt8] {
    guard let p = prepare(params) else { return emptyEnvelope }
    return assemble(
      p, conn: conn, titleExact: conn.titleExactRows(p.ftsParams) ?? [],
      fts: conn.ftsRows(p.ftsParams) ?? [], trigram: conn.trigramRows(p.trigramParams) ?? [])
  }

  /// Merges the three tiers (title-exact → FTS → trigram, dedup-by-path
  /// keep-first), reranks, slices, and projects to the JSON envelope. Pure —
  /// identical regardless of how the tiers were executed, so byte-parity is
  /// independent of the parallel/sequential choice.
  public static func assemble(
    _ p: PreparedSearch, conn: StorageConnection? = nil, titleExact: [SearchRow], fts: [SearchRow],
    trigram: [SearchRow]
  ) -> [UInt8] {
    let q = p.q
    let limit = p.limit
    let offset = p.offset

    var results: [ResultHit] = []
    var seen: Set<String> = []
    func addRows(_ rows: [SearchRow], quality: (SearchRow) -> String) {
      for row in rows where seen.insert(row.path).inserted {
        var hit = ResultHit(row, matchQuality: quality(row))
        hit.origIndex = results.count
        results.append(hit)
      }
    }
    addRows(titleExact) { _ in "exact" }
    addRows(fts) { row in
      if let t = row.tier, t >= 0, t < 4 { return tierLabels[Int(t)] }
      return "match"
    }
    addRows(trigram) { _ in "substring" }

    // Tier 4: body FTS (search.js:276) — merge only when the strict tiers
    // haven't filled the requested window. `bodyRows` self-guards on the table's
    // presence (→ [] when absent), matching the JS hasBody gate's output. Needs
    // the connection; skipped in the pure (conn == nil) path.
    if let conn, results.count < limit + offset {
      addRows(conn.bodyRows(p.ftsParams) ?? []) { _ in "body" }
    }

    let intent = IntentDetector.detect(q)
    Rerank.apply(&results, query: q, intent: intent)

    let total = results.count
    let start = min(offset, total)
    let end = min(offset + limit, total)
    var sliced = Array(results[start..<end])
    let hasMore = total >= offset + limit && sliced.count == limit

    if let conn { enrich(conn, &sliced, query: q) }
    return projectEnvelope(query: q, total: total, hasMore: hasMore, hits: sliced)
  }

  /// Snippet + relatedCount enrichment of the final page (mirrors
  /// src/commands/search.js:309-326). Best-effort: a missing
  /// document_relationships table → getRelatedDocCounts returns nil → the whole
  /// block is skipped, exactly like the JS try/catch (neither field emitted).
  private static func enrich(_ conn: StorageConnection, _ hits: inout [ResultHit], query: String) {
    guard !hits.isEmpty else { return }
    let keys = hits.map(\.path)
    let snippetData = conn.getDocumentSnippetData(keys)
    guard let counts = conn.getRelatedDocCounts(keys) else { return }
    for i in hits.indices {
      if let data = snippetData[hits[i].path] {
        hits[i].snippet = Snippet.render(data, query: query)
      }
      hits[i].relatedCount = counts[hits[i].path] ?? 0
    }
  }

  // MARK: - projection (projectSearchResult + projectSearchHit, webPaths:false)

  private static func projectEnvelope(query: String, total: Int, hasMore: Bool, hits: [ResultHit])
    -> [UInt8]
  {
    var w = JSONWriter()
    w.openObject()
    w.key("query"); w.string(query)
    w.key("total"); w.int(total)
    w.key("hasMore"); w.bool(hasMore)
    w.key("results")
    w.openArray()
    for hit in hits { projectHit(&w, hit) }
    w.closeArray()
    w.closeObject()
    return w.bytes
  }

  private static func projectHit(_ w: inout JSONWriter, _ h: ResultHit) {
    w.openObject()
    w.key("path"); w.string(h.path)
    w.key("title"); w.stringOrNull(h.title)
    w.key("framework"); w.stringOrNull(h.framework)
    w.key("rootSlug"); w.stringOrNull(h.rootSlug)
    w.key("kind"); w.stringOrNull(h.kind)
    w.key("sourceType"); w.stringOrNull(h.sourceType)
    w.key("abstract"); w.stringOrNull(h.abstract)
    w.key("declaration"); w.stringOrNull(h.declaration)
    w.key("platforms"); w.rawOrEmptyArray(h.platforms)  // raw platforms_json verbatim, or []
    w.key("language"); w.stringOrNull(h.language)
    if let snippet = h.snippet { w.key("snippet"); w.string(snippet) }
    if let relatedCount = h.relatedCount { w.key("relatedCount"); w.int(relatedCount) }
    w.key("confidence"); w.string(publicConfidence(h.matchQuality))
    if h.isDeprecated { w.key("isDeprecated"); w.raw("true") }
    if h.isBeta { w.key("isBeta"); w.raw("true") }
    if h.isReleaseNotes { w.key("isReleaseNotes"); w.raw("true") }
    w.closeObject()
  }

  /// publicConfidence(matchQuality) (src/output/confidence.js).
  private static func publicConfidence(_ matchQuality: String) -> String {
    if matchQuality == "exact" { return "exact" }
    if matchQuality == "fuzzy" { return "approximate" }
    if matchQuality.hasPrefix("relaxed") { return "approximate" }
    return "partial"
  }
}
