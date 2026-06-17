// Post-cascade filtering — byte-exact port of matchesSearchFilters + version
// helpers. The SQL predicates push most filters down; this is the precise
// re-check (kind taxonomy + platform-version sentinel) applied at every merge
// point.

import ADBase  // CheckedMath — overflow-checked version-component parse
import ADContent  // JsString — JS trim/toLowerCase
import ADJSONCore  // JSONValue — parse platforms_json for the '0' platform sentinel
import ADStorage  // SearchRow
import OrderedCollections

struct PlatformFilters: Sendable {
  var minIos: String?
  var minMacos: String?
  var minWatchos: String?
  var minTvos: String?
  var minVisionos: String?
  var any: Bool { minIos != nil || minMacos != nil || minWatchos != nil || minTvos != nil || minVisionos != nil }
}

/// The residual filters consulted post-cascade.
struct ActiveFilters: Sendable {
  var frameworks: [String?] = [nil]
  var sourceTypes: Set<String>?
  var kind: String?
  var language: String?
  var platformFilters = PlatformFilters()
  var year: Int?
  var track: String?
  var deprecated: String = "include"
}

enum Filters {
  private static let roleKindFilters: Set<String> = [
    "symbol", "article", "collection", "overview", "tutorial", "samplecode", "sample_code",
    "sample-project", "sampleproject",
  ]

  static func matches(_ row: SearchRow, _ f: ActiveFilters) -> Bool {
    matchesSource(row, f.sourceTypes)
      && matchesFramework(row, f.frameworks)
      && matchesKind(row, f.kind)
      && matchesLanguage(row, f.language)
      && matchesPlatform(row, f.platformFilters)
      && matchesMetadata(row, f.year, f.track)
      && matchesDeprecated(row, f.deprecated)
  }

  // MARK: - individual matchers

  private static func matchesSource(_ row: SearchRow, _ sourceTypes: Set<String>?) -> Bool {
    guard let sourceTypes else { return true }
    return sourceTypes.contains(JsString.lowercase(row.sourceType ?? ""))
  }

  private static func matchesDeprecated(_ row: SearchRow, _ mode: String) -> Bool {
    if mode == "include" { return true }
    let deprecated = (row.isDeprecated ?? 0) != 0
    if mode == "exclude" { return !deprecated }
    if mode == "only" { return deprecated }
    return true
  }

  private static func matchesFramework(_ row: SearchRow, _ frameworks: [String?]) -> Bool {
    let candidates = frameworks.compactMap { $0 }.map(normalize).filter { !$0.isEmpty }
    if candidates.isEmpty { return true }
    let rowValues = [normalize(row.rootSlug ?? ""), normalize(row.framework ?? "")].filter { !$0.isEmpty }
    return rowValues.contains { candidates.contains($0) }
  }

  private static func matchesKind(_ row: SearchRow, _ kind: String?) -> Bool {
    guard let kind else { return true }
    let target = normalize(kind)
    if target.isEmpty { return true }
    let displayedKind = normalize(row.roleHeading ?? "")
    // "Article" / "Sample Code" arrive original-case → match role_heading;
    // lowercase values like `symbol` match role / doc_kind.
    if kind != JsString.lowercase(kind) { return displayedKind == target }
    let roleCandidates = [normalize(row.role ?? ""), normalize(row.docKind ?? "")].filter { !$0.isEmpty }
    if roleKindFilters.contains(target) { return roleCandidates.contains(target) }
    return displayedKind == target
  }

  private static func matchesLanguage(_ row: SearchRow, _ language: String?) -> Bool {
    guard let language else { return true }
    let normalized = normalize(language)
    let value = normalize(row.language ?? "")
    return value.isEmpty || value == normalized || value == "both"
  }

  private static func matchesPlatform(_ row: SearchRow, _ pf: PlatformFilters) -> Bool {
    var platformKeys: [String]?
    func keys() -> [String] {
      if let platformKeys { return platformKeys }
      let parsed = parsePlatformKeys(row.platforms)
      platformKeys = parsed
      return parsed
    }
    let checks: [(requested: String?, key: String, actual: String?)] = [
      (pf.minIos, "ios", row.minIos), (pf.minMacos, "macos", row.minMacos),
      (pf.minWatchos, "watchos", row.minWatchos), (pf.minTvos, "tvos", row.minTvos),
      (pf.minVisionos, "visionos", row.minVisionos),
    ]
    for check in checks {
      if !matchesPlatformVersion(check.actual, check.requested, key: check.key, keys: keys) { return false }
    }
    return true
  }

  private static func matchesPlatformVersion(
    _ actual: String?, _ requested: String?, key: String, keys: () -> [String]
  ) -> Bool {
    guard let requested, !requested.isEmpty else { return true }
    if requested == "0" {
      if let actual, !actual.isEmpty { return true }
      let explicit = keys()
      if explicit.isEmpty { return true }
      return explicit.contains(key)
    }
    guard let actual, !actual.isEmpty else { return true }
    return compareVersions(actual, requested) <= 0
  }

  private static func matchesMetadata(_ row: SearchRow, _ year: Int?, _ track: String?) -> Bool {
    let hasYear = (year ?? 0) != 0
    let hasTrack = !(track ?? "").isEmpty
    if !hasYear && !hasTrack { return true }
    guard let metadata = parseObject(row.sourceMetadata) else { return false }
    if hasYear, numberValue(metadata["year"]) != Double(year!) { return false }
    if hasTrack {
      let metaTrack = normalize(stringValue(metadata["track"]) ?? "")
      if !metaTrack.contains(normalize(track!)) { return false }
    }
    return true
  }

  // MARK: - helpers

  /// normalizeFilterValue: String(v ?? '').trim().toLowerCase().
  static func normalize(_ value: String) -> String { JsString.lowercase(JsString.trim(value)) }

  private static func parsePlatformKeys(_ json: String?) -> [String] {
    guard let json, !json.isEmpty, let value = try? JSONValue(parsing: json),
      let object = objectValue(value)
    else { return [] }
    return Array(object.keys)
  }

  private static func parseObject(_ json: String?) -> OrderedDictionary<String, JSONValue>? {
    guard let json, !json.isEmpty, let value = try? JSONValue(parsing: json) else { return nil }
    return objectValue(value)
  }

  /// JS Number coercion of an object member — JSON integers parse to `.int`,
  /// non-integers to `.number`; both read back as `Double` (nil otherwise).
  private static func numberValue(_ value: JSONValue?) -> Double? {
    switch value {
    case .number(let n): return n
    case .int(let i): return Double(i)
    default: return nil
    }
  }

  private static func stringValue(_ value: JSONValue?) -> String? {
    if case .string(let s) = value { return s }
    return nil
  }

  private static func objectValue(_ value: JSONValue?) -> OrderedDictionary<String, JSONValue>? {
    if case .object(let object) = value { return object }
    return nil
  }

  /// compareVersions(left, right): componentwise over the \d+ runs.
  static func compareVersions(_ left: String, _ right: String) -> Int {
    let l = versionParts(left)
    let r = versionParts(right)
    for i in 0..<max(l.count, r.count) {
      let lp = i < l.count ? l[i] : 0
      let rp = i < r.count ? r[i] : 0
      if lp != rp { return lp < rp ? -1 : 1 }
    }
    return 0
  }

  /// parseVersionParts: every \d+ run as an Int. Adversarial digit runs
  /// saturate at `Int.max` rather than trapping (ordering is preserved).
  private static func versionParts(_ version: String) -> [Int] {
    var parts: [Int] = []
    var current = 0
    var inRun = false
    for s in version.unicodeScalars {
      if s.value >= 48 && s.value <= 57 {
        let digit = Int(s.value - 48)
        if let scaled = current.checkedMultiplied(by: 10), let next = scaled.checkedAdded(digit) {
          current = next
        } else {
          current = Int.max
        }
        inRun = true
      } else if inRun {
        parts.append(current)
        current = 0
        inRun = false
      }
    }
    if inRun { parts.append(current) }
    return parts
  }

  // MARK: - filter-bag normalizers

  /// normalizeSourceFilter: comma-split, trim, lowercase, drop empties — ordered
  /// unique (the JSON array for `$sources_json` keeps this order; matching is
  /// order-independent).
  static func normalizeSourceList(_ source: String?) -> [String] {
    guard let source, !source.isEmpty else { return [] }
    var seen = Set<String>()
    var out: [String] = []
    for part in source.split(separator: ",", omittingEmptySubsequences: false) {
      let value = normalize(String(part))
      if !value.isEmpty, seen.insert(value).inserted { out.append(value) }
    }
    return out
  }

  static func normalizeDeprecatedFilter(_ value: String?) -> String {
    guard let value, !value.isEmpty else { return "include" }
    let v = normalize(value)
    return (v == "exclude" || v == "only" || v == "include") ? v : "include"
  }

  /// buildPlatformFilters: the explicit min versions, plus a `'0'` sentinel for
  /// the named `platform` when that slot is unset.
  static func buildPlatformFilters(
    platform: String?, minIos: String?, minMacos: String?, minWatchos: String?, minTvos: String?,
    minVisionos: String?
  ) -> PlatformFilters {
    var f = PlatformFilters(
      minIos: minIos, minMacos: minMacos, minWatchos: minWatchos, minTvos: minTvos,
      minVisionos: minVisionos)
    if let platform, !platform.isEmpty {
      switch normalize(platform) {
      case "ios": if f.minIos == nil { f.minIos = "0" }
      case "macos": if f.minMacos == nil { f.minMacos = "0" }
      case "watchos": if f.minWatchos == nil { f.minWatchos = "0" }
      case "tvos": if f.minTvos == nil { f.minTvos = "0" }
      case "visionos": if f.minVisionos == nil { f.minVisionos = "0" }
      default: break
      }
    }
    return f
  }

  /// `%<lowercased-trimmed>%` for the `$track_like` LIKE, or nil.
  static func trackLike(_ track: String?) -> String? {
    guard let track else { return nil }
    let trimmed = JsString.trim(track)
    return trimmed.isEmpty ? nil : "%\(JsString.lowercase(trimmed))%"
  }

  /// JSON array string of the source list (`$sources_json`), or nil.
  static func sourcesJson(_ sources: [String]) -> String? {
    guard !sources.isEmpty else { return nil }
    func esc(_ s: String) -> String {
      var out = ""
      for ch in s {
        if ch == "\"" || ch == "\\" { out.append("\\") }
        out.append(ch)
      }
      return out
    }
    return "[" + sources.map { "\"\(esc($0))\"" }.joined(separator: ",") + "]"
  }
}
