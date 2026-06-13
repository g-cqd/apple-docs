// Minimal query-string parsing for /search (RFC 0001 P6 spike). No
// Foundation. Builds a SearchPagesParams from ?q=&framework=&limit=… ; the
// spike exercises the FTS5 read path, so the unused filter fields stay nil.

import ADSearchCascade
import ADStorage

/// Parses ?q=&limit=&offset= into the cascade's SearchParams (phase 1 — the
/// filter bag lands in a follow-on).
func parseCascadeParams(_ uri: String) -> SearchParams {
  let q = parseQuery(uri)
  return SearchParams(
    query: q["q"] ?? "",
    limit: Int(q["limit"] ?? "") ?? 100,
    offset: Int(q["offset"] ?? "") ?? 0)
}

func parseSearchParams(_ uri: String) -> SearchPagesParams {
  let q = parseQuery(uri)
  let query = q["q"] ?? ""
  let limit = Int64(q["limit"] ?? "") ?? 100
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
  case UInt8(ascii: "0")...UInt8(ascii: "9"): return b - UInt8(ascii: "0")
  case UInt8(ascii: "a")...UInt8(ascii: "f"): return b - UInt8(ascii: "a") + 10
  case UInt8(ascii: "A")...UInt8(ascii: "F"): return b - UInt8(ascii: "A") + 10
  default: return nil
  }
}
