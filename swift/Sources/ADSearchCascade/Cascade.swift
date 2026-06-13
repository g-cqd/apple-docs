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

public enum Cascade {
  private static let tierLabels = ["exact", "prefix", "contains", "match"]

  /// Runs the cascade on `conn` and returns the projected JSON envelope.
  public static func search(_ conn: StorageConnection, _ params: SearchParams) -> [UInt8] {
    let q = trimWS(params.query)
    if q.isEmpty {
      return Array(#"{"query":"","total":0,"results":[]}"#.utf8)
    }
    let limit = max(params.limit, 1)
    let offset = max(params.offset, 0)
    let requestedWindow = limit + offset

    let ftsQuery = FtsQuery.build(q)
    let trigramQuery = FtsQuery.trigram(q)

    // Phase 1: single query, no JS post-filters → searchLimit = requestedWindow,
    // no framework / source / kind / platform filters.
    let base = SearchPagesParams(
      query: ftsQuery, raw: q, limit: Int64(requestedWindow), framework: nil, sourceType: nil,
      sourcesJson: nil, kind: nil, language: nil, year: nil, trackLike: nil,
      deprecatedMode: "include", minIos: nil, minMacos: nil, minWatchos: nil, minTvos: nil,
      minVisionos: nil)
    var trigramParams = base
    trigramParams.query = trigramQuery

    let titleExact = conn.titleExactRows(base) ?? []
    let fts = conn.ftsRows(base) ?? []
    let trigram = conn.trigramRows(trigramParams) ?? []

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

    let intent = IntentDetector.detect(q)
    Rerank.apply(&results, query: q, intent: intent)

    let total = results.count
    let start = min(offset, total)
    let end = min(offset + limit, total)
    let sliced = Array(results[start..<end])
    let hasMore = total >= offset + limit && sliced.count == limit

    return projectEnvelope(query: q, total: total, hasMore: hasMore, hits: sliced)
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
