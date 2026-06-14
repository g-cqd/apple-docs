// The formatted search hit (port of src/search/format.js formatResult). The
// cascade merges SearchRows into ResultHits (assigning matchQuality), rerank
// scores them, projection emits them. Only the fields rerank + the projection
// allowlist need are kept.

import ADStorage

struct ResultHit {
  var path: String
  var title: String?
  var framework: String?
  var rootSlug: String?
  var sourceType: String?
  var kind: String?  // role_heading ?? role
  var abstract: String?
  var declaration: String?
  var platforms: String?  // raw platforms_json — emitted verbatim (JSON round-trip is identity)
  var language: String?
  var urlDepth: Int64
  var isReleaseNotes: Bool
  var isDeprecated: Bool
  var isBeta: Bool
  var matchQuality: String

  var score: Double = 0
  var origIndex: Int = 0  // insertion order, for a stable total-order sort

  // Enrichment (phase 2) — nil = not enriched (omitted from the projection,
  // matching JS where a thrown getRelatedDocCounts skips the whole block).
  var snippet: String?
  var relatedCount: Int?

  /// formatResult(row, matchQuality).
  init(_ row: SearchRow, matchQuality: String) {
    path = row.path
    title = row.title
    framework = row.framework
    rootSlug = row.rootSlug
    sourceType = row.sourceType
    kind = row.roleHeading ?? row.role
    abstract = row.abstract
    declaration = row.declaration
    platforms = row.platforms
    language = row.language
    urlDepth = row.urlDepth ?? 0
    isReleaseNotes = (row.isReleaseNotes ?? 0) != 0
    isDeprecated = (row.isDeprecated ?? 0) != 0
    isBeta = (row.isBeta ?? 0) != 0
    self.matchQuality = matchQuality
  }
}
