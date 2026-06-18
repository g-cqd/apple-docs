// Minimal query-string parsing for /search. No Foundation. Builds a
// SearchPagesParams from ?q=&framework=&limit=… ; unused filter fields stay nil.

import ADSearchCascade
import ADStorage

/// Max accepted search-query length (bytes). Real queries are short symbol/API
/// terms; rejecting multi-KB inputs at the edge stops a request-cheap /
/// server-expensive regex + tokenize + MATCH from running on adversarial text.
let maxSearchQueryBytes = 4096

/// Clamps a requested search `limit` to the served window: lower bound 1 (JS
/// `Math.max(_, 1)`), upper bound `upperBound` (JS web `Math.min(_, 200)`; MCP
/// advertises 1...100). The advertised schema bounds are advisory, so enforce
/// them server-side regardless of transport.
func clampSearchLimit(_ value: Int, upperBound: Int = 200) -> Int {
    min(max(value, 1), upperBound)
}

/// Parses ?q=&limit=&offset= + the filter bag (framework/source/kind/language/
/// platform/minVersion/year/track/deprecated) into the cascade's SearchParams.
func parseCascadeParams(_ uri: String) -> SearchParams {
    let q = parseQuery(uri)
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

func parseSearchParams(_ uri: String) -> SearchPagesParams {
    let q = parseQuery(uri)
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

func parseQuery(_ uri: String) -> [String: String] {
    guard let mark = uri.firstIndex(of: "?") else { return [:] }
    var out: [String: String] = [:]
    for pair in uri[uri.index(after: mark)...].split(separator: "&") {
        let kv = pair.split(separator: "=", maxSplits: 1)
        guard let key = kv.first else { continue }
        out[percentDecode(String(key))] = kv.count > 1 ? percentDecode(String(kv[1])) : ""
    }
    return out
}

func percentDecode(_ s: String) -> String {
    let chars = Array(s.utf8)
    var bytes: [UInt8] = []
    bytes.reserveCapacity(chars.count)
    var i = 0
    while i < chars.count {
        let c = chars[i]
        if c == UInt8(ascii: "+") {
            bytes.append(UInt8(ascii: " "))
            i += 1
        } else if c == UInt8(ascii: "%"), i + 2 < chars.count,
            let hi = hexVal(chars[i + 1]), let lo = hexVal(chars[i + 2])
        {
            bytes.append(hi << 4 | lo)
            i += 3
        } else {
            bytes.append(c)
            i += 1
        }
    }
    return String(decoding: bytes, as: UTF8.self)
}

private func hexVal(_ b: UInt8) -> UInt8? {
    switch b {
        case UInt8(ascii: "0") ... UInt8(ascii: "9"): return b - UInt8(ascii: "0")
        case UInt8(ascii: "a") ... UInt8(ascii: "f"): return b - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A") ... UInt8(ascii: "F"): return b - UInt8(ascii: "A") + 10
        default: return nil
    }
}
