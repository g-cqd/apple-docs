// The in-process lexical search cascade (RFC 0001 P6). Orchestrates the three
// lexical tiers on ONE connection in ONE offload, merges (title-exact → FTS →
// trigram, dedup-by-path keep-first), reranks, slices, and projects to the
// public JSON envelope — byte-identical to JS
// projectSearchResult(search(opts,ctx)) for the lexical subset. Phase 1: no
// snippet/relatedCount enrichment, no kind/platform JS filters, no framework
// fan-out (single, no-filter query) — those land in follow-ons.

import ADContent
import ADStorage

public struct SearchParams: Sendable {
  public var query: String
  public var limit: Int
  public var offset: Int
  public var framework: String?
  public var source: String?
  public var kind: String?
  public var language: String?
  public var platform: String?
  public var minIos: String?
  public var minMacos: String?
  public var minWatchos: String?
  public var minTvos: String?
  public var minVisionos: String?
  public var year: Int?
  public var track: String?
  public var deprecated: String?
  public init(
    query: String, limit: Int = 100, offset: Int = 0, framework: String? = nil,
    source: String? = nil, kind: String? = nil, language: String? = nil, platform: String? = nil,
    minIos: String? = nil, minMacos: String? = nil, minWatchos: String? = nil,
    minTvos: String? = nil, minVisionos: String? = nil, year: Int? = nil, track: String? = nil,
    deprecated: String? = nil
  ) {
    self.query = query
    self.limit = limit
    self.offset = offset
    self.framework = framework
    self.source = source
    self.kind = kind
    self.language = language
    self.platform = platform
    self.minIos = minIos
    self.minMacos = minMacos
    self.minWatchos = minWatchos
    self.minTvos = minTvos
    self.minVisionos = minVisionos
    self.year = year
    self.track = track
    self.deprecated = deprecated
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
  let activeFilters: ActiveFilters  // JS-side re-check (internal — used only by assemble)
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

    // Normalize the filter bag (search.js + filters.js + buildFilterParams).
    let framework = nonEmptyValue(params.framework)
    let kind = nonEmptyValue(params.kind)
    let language = nonEmptyValue(params.language)
    let sources = Filters.normalizeSourceList(params.source)
    let sqlSourceType = sources.count == 1 ? sources[0] : nil
    let deprecated = Filters.normalizeDeprecatedFilter(params.deprecated)
    let platformFilters = Filters.buildPlatformFilters(
      platform: params.platform, minIos: nonEmptyValue(params.minIos),
      minMacos: nonEmptyValue(params.minMacos), minWatchos: nonEmptyValue(params.minWatchos),
      minTvos: nonEmptyValue(params.minTvos), minVisionos: nonEmptyValue(params.minVisionos))
    // Only `kind` + platform-version stay JS-side → 3× over-fetch when active.
    let hasJsPostFilters = kind != nil || platformFilters.any
    let searchLimit = hasJsPostFilters ? min(max(requestedWindow * 3, 60), 300) : requestedWindow

    // SQL params: framework / source / kind / language / year / track /
    // deprecated push down; the `$min_*` stay nil — platform filtering is
    // entirely JS-side (matchesSearchFilters), matching search.js's filterOpts.
    let base = SearchPagesParams(
      query: FtsQuery.build(q), raw: q, limit: Int64(searchLimit), framework: framework,
      sourceType: sqlSourceType, sourcesJson: Filters.sourcesJson(sources), kind: kind,
      language: language, year: params.year.map(Int64.init), trackLike: Filters.trackLike(params.track),
      deprecatedMode: deprecated, minIos: nil, minMacos: nil, minWatchos: nil, minTvos: nil,
      minVisionos: nil)
    var trigram = base
    trigram.query = FtsQuery.trigram(q)

    let active = ActiveFilters(
      frameworks: [framework], sourceTypes: sources.isEmpty ? nil : Set(sources), kind: kind,
      language: language, platformFilters: platformFilters, year: params.year, track: params.track,
      deprecated: deprecated)
    return PreparedSearch(
      q: q, ftsParams: base, trigramParams: trigram, limit: limit, offset: offset,
      activeFilters: active)
  }

  /// Runs the cascade on `conn` SEQUENTIALLY and returns the JSON envelope
  /// (convenience for tests; the server fans the tiers in parallel + calls
  /// `assemble`).
  public static func search(_ conn: StorageConnection, _ params: SearchParams) -> [UInt8] {
    guard let prepared = prepare(params) else { return emptyEnvelope }
    // Framework-synonym expansion (search.js:137): run each strict tier once per
    // framework (canonical + synonyms) and concatenate, and widen the
    // matchesFrameworkFilter set to the same list.
    let frameworks = resolveFrameworks(conn, nonEmptyValue(params.framework))
    var filters = prepared.activeFilters
    filters.frameworks = frameworks
    let p = PreparedSearch(
      q: prepared.q, ftsParams: prepared.ftsParams, trigramParams: prepared.trigramParams,
      limit: prepared.limit, offset: prepared.offset, activeFilters: filters)
    return assemble(
      p, conn: conn, titleExact: fanout(frameworks, p.ftsParams) { conn.titleExactRows($0) },
      fts: fanout(frameworks, p.ftsParams) { conn.ftsRows($0) },
      trigram: fanout(frameworks, p.trigramParams) { conn.trigramRows($0) })
  }

  /// [framework] expanded with its synonyms (deduped, canonical first); [nil]
  /// when no framework filter (the single no-filter query).
  private static func resolveFrameworks(_ conn: StorageConnection, _ base: String?) -> [String?] {
    guard let base else { return [nil] }
    var frameworks: [String?] = [base]
    for synonym in conn.getFrameworkSynonyms(base) where !frameworks.contains(synonym) {
      frameworks.append(synonym)
    }
    return frameworks
  }

  /// Runs `tier` once per framework (overriding `$framework`) and concatenates
  /// in framework order (the JS `frameworks.map(...).flat()`).
  private static func fanout(
    _ frameworks: [String?], _ params: SearchPagesParams,
    _ tier: (SearchPagesParams) -> [SearchRow]?
  ) -> [SearchRow] {
    var out: [SearchRow] = []
    for framework in frameworks {
      var params = params
      params.framework = framework
      out.append(contentsOf: tier(params) ?? [])
    }
    return out
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

    let filters = p.activeFilters
    var results: [ResultHit] = []
    var seen: Set<String> = []
    // addResults (search.js:183): JS-side filter THEN dedup-by-path keep-first.
    func addRows(_ rows: [SearchRow], quality: (SearchRow) -> String) {
      for row in rows {
        if !Filters.matches(row, filters) { continue }
        if seen.insert(row.path).inserted {
          var hit = ResultHit(row, matchQuality: quality(row))
          hit.origIndex = results.count
          results.append(hit)
        }
      }
    }
    addRows(titleExact) { _ in "exact" }
    addRows(fts) { row in
      if let t = row.tier, t >= 0, t < 4 { return tierLabels[Int(t)] }
      return "match"
    }
    addRows(trigram) { _ in "substring" }

    // Deep tiers need the connection (skipped in the pure conn == nil path).
    if let conn {
      // Tier 3: fuzzy Levenshtein (search.js:249) — only when T1+T2 produced < 5
      // hits and the query is >= 4 UTF-16 units. Candidates in distance order,
      // deduped, merged with matchQuality 'fuzzy'.
      if results.count < 5, q.utf16.count >= 4 {
        let ids = Fuzzy.matchTitles(conn, query: q, limit: Int(p.ftsParams.limit))
        if !ids.isEmpty {
          let records = conn.searchRecordsByIds(ids)
          for id in ids {
            guard let record = records[id], Filters.matches(record, filters),
              seen.insert(record.path).inserted
            else { continue }
            var hit = ResultHit(record, matchQuality: "fuzzy")
            hit.origIndex = results.count
            results.append(hit)
          }
        }
      }
      // Tier 4: body FTS (search.js:276) — merge only when the strict + fuzzy
      // tiers haven't filled the requested window. `bodyRows` self-guards on the
      // table's presence (→ [] when absent), matching the JS hasBody gate.
      if results.count < limit + offset {
        addRows(fanout(filters.frameworks, p.ftsParams) { conn.bodyRows($0) }) { _ in "body" }
      }

      // Relaxation cascade R1-R3 (cascade.js runRelaxationCascade) — only when
      // the strict + deep tiers produced NOTHING, the trimmed query is >= 4
      // UTF-16 units with no `"`, and it tokenizes to >= 3 tokens.
      if results.isEmpty, q.utf16.count >= 4, !q.contains("\"") {
        let tokens = Relaxation.tokenize(q)
        if tokens.count >= 3 {
          let pruned = Relaxation.pruneStopwords(tokens)
          // R1 — pruned AND
          if pruned.count >= 1 {
            var params = p.ftsParams
            params.query = FtsQuery.build(pruned.joined(separator: " "))
            addRows(fanout(filters.frameworks, params) { conn.ftsRows($0) }) { _ in "relaxed" }
          }
          // R2 — pruned OR (lowercased, quote-stripped, OR-joined)
          if results.isEmpty, pruned.count >= 2 {
            var params = p.ftsParams
            params.query =
              pruned.map { "\"\(stripQuotes(JsString.lowercase($0)))\"" }.joined(separator: " OR ")
            addRows(fanout(filters.frameworks, params) { conn.ftsRows($0) }) { _ in "relaxed-or" }
          }
          // R3 — trigram on a single high-signal token
          if results.isEmpty {
            let pool = pruned.isEmpty ? tokens : pruned
            if let signal = Relaxation.pickHighSignalToken(pool), signal.utf16.count >= 3 {
              var params = p.trigramParams
              params.query = FtsQuery.trigram(signal)
              addRows(fanout(filters.frameworks, params) { conn.trigramRows($0) }) { _ in "relaxed-token" }
            }
          }
        }
      }
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
    // projectSearchResult: `approximate: true` when any projected hit's
    // confidence is 'approximate' (fuzzy / relaxed). Emitted after `results`.
    if hits.contains(where: { publicConfidence($0.matchQuality) == "approximate" }) {
      w.key("approximate")
      w.raw("true")
    }
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

  /// Removes every `"` (JS `.replace(/"/g, '')`) — for the R2 OR query terms.
  private static func stripQuotes(_ s: String) -> String {
    String(s.unicodeScalars.filter { $0 != "\"" })
  }

  /// nil for nil/empty (JS `value ?? null` where '' is falsy in the filter bag).
  private static func nonEmptyValue(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
  }
}
