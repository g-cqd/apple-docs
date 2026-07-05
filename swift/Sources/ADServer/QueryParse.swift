// Minimal query-string parsing for /search. No Foundation. Builds a
// SearchPagesParams from ?q=&framework=&limit=… ; unused filter fields stay nil.

import ADFCore
import ADSearchCascade
import ADStorage

/// Max accepted search-query length (bytes). Real queries are short symbol/API
/// terms; rejecting multi-KB inputs at the edge stops a request-cheap /
/// server-expensive regex + tokenize + MATCH from running on adversarial text.
let maxSearchQueryBytes = 4096

/// Clamps a requested search `limit` to the served window: lower bound 1,
/// upper bound `upperBound`. WEB-ONLY: this mirrors JS's OWN web-layer
/// behavior (`Math.min(Math.max(limit, 1), 200)` in the `/search`/
/// `/api/symbols/search` query-string handlers, which never went through
/// zod) — the two callers below (`parseCascadeParams`/`parseSearchParams`,
/// both HTTP query-string parsing) are the only ones that should still clamp.
///
/// The MCP tool surface is different: JS's zod schemas REJECT out-of-range
/// `limit`/`maxChars`/`page`/`size`/... at decode time rather than clamping,
/// and RFC 0001/0007 call the MCP tool contract byte/contract-compatible —
/// a non-goal to diverge on. `Tools.swift`'s MCP handlers use `validateBound`
/// below instead of this function (or the former `clampSymbolLimitInt`/
/// `clampInteger`, both removed) to match that reject-not-clamp behavior.
func clampSearchLimit(_ value: Int, upperBound: Int = 200) -> Int {
    min(max(value, 1), upperBound)
}

/// Validates a schema-advertised numeric bound that ADJSON's `@SchemaNumber`
/// macro only ADVERTISES in the generated JSON Schema — it has no runtime
/// enforcement, unlike the JS MCP surface's zod schemas, which reject
/// out-of-range input at decode time, before the tool handler ever runs.
/// Every `@SchemaNumber`-bounded MCP tool INPUT field (as opposed to the web
/// query-string params `clampSearchLimit` above still serves) is checked with
/// this instead of being silently clamped. Returns an error message ready for
/// `MCPToolResult.failure` (nil when `value` is nil or within `range`).
func validateBound(_ value: Int?, _ range: ClosedRange<Int>, field: String) -> String? {
    guard let value, !range.contains(value) else { return nil }
    return "\(field) must be between \(range.lowerBound) and \(range.upperBound)."
}

/// Parses ?q=&limit=&offset= + the filter bag (framework/source/kind/language/
/// platform/minVersion/year/track/deprecated) into the cascade's SearchParams.
func parseCascadeParams(_ uri: String) -> SearchParams? {
    guard let q = parseQuery(uri) else { return nil }
    return SearchParams(
        query: q["q"] ?? "",
        limit: clampSearchLimit(Int(q["limit"] ?? "") ?? 100),
        offset: max(Int(q["offset"] ?? "") ?? 0, 0),
        framework: q["framework"],
        source: q["source"],
        kind: q["kind"],
        language: q["language"],
        platform: q["platform"],
        minIos: q["minIos"] ?? q["min-ios"],
        minMacos: q["minMacos"] ?? q["min-macos"],
        minWatchos: q["minWatchos"] ?? q["min-watchos"],
        minTvos: q["minTvos"] ?? q["min-tvos"],
        minVisionos: q["minVisionos"] ?? q["min-visionos"],
        year: q["year"].flatMap { Int($0) },
        track: q["track"],
        deprecated: q["deprecated"])
}

func parseSearchParams(_ uri: String) -> SearchPagesParams? {
    guard let q = parseQuery(uri) else { return nil }
    let query = q["q"] ?? ""
    let limit = Int64(clampSearchLimit(Int(q["limit"] ?? "") ?? 100))
    return SearchPagesParams(
        query: query, raw: query, limit: limit,
        framework: nonEmpty(q["framework"]), sourceType: nonEmpty(q["source"]),
        sourcesJson: nil, kind: nonEmpty(q["kind"]), language: nonEmpty(q["language"]),
        year: nil, trackLike: nil, deprecatedMode: "include",
        minIos: nil, minMacos: nil, minWatchos: nil, minTvos: nil, minVisionos: nil)
}

private func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}

/// Parses the query string into decoded key/value pairs, or `nil` if ANY component is malformed
/// (a bad percent-escape or invalid UTF-8) — the caller then rejects the request rather than
/// serving a silently mis-decoded query. A URI with no `?` yields an empty bag.
func parseQuery(_ uri: String) -> [String: String]? {
    guard let mark = uri.firstIndex(of: "?") else { return [:] }
    var out: [String: String] = [:]
    for pair in uri[uri.index(after: mark)...].split(separator: "&") {
        let kv = pair.split(separator: "=", maxSplits: 1)
        guard let key = kv.first else { continue }
        guard let decodedKey = percentDecode(String(key)) else { return nil }
        if kv.count > 1 {
            guard let decodedValue = percentDecode(String(kv[1])) else { return nil }
            out[decodedKey] = decodedValue
        } else {
            out[decodedKey] = ""
        }
    }
    return out
}

/// Percent-decodes one `application/x-www-form-urlencoded` query component (the `"+"`→space rule)
/// through the audited ``ADFCore/PercentCoding/decodeForm(_:)``, then *validates* the result is
/// well-formed UTF-8 via ``ADFCore/UTF8Validation``. Returns `nil` on a malformed escape (`"%"`,
/// `"%G0"`) OR invalid UTF-8 (`"%FF"`, a bad continuation) so the caller can reject the request —
/// rather than the prior `String(decoding:as:)`, which silently substituted U+FFFD for adversarial
/// query bytes.
func percentDecode(_ s: String) -> String? {
    guard let bytes = PercentCoding.decodeForm(Array(s.utf8)),
        UTF8Validation.firstInvalidByte(bytes) == nil
    else { return nil }
    return String(decoding: bytes, as: UTF8.self)
}
