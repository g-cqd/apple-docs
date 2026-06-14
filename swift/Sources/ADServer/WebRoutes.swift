// JSON framing for the in-process web routes (RFC 0001 P6 web slice). Each
// builder emits bytes byte-identical to the Bun handler's `Response.json(...)`
// body via the streaming writer (caller-ordered keys). Storage stays typed
// (ADStorage returns facets/rows); presentation lives here.

import ADJSON
import ADStorage
import Foundation

enum WebRoutes {
  /// GET /api/filters body (src/web/routes/filters.route.js).
  static func filters(_ conn: StorageConnection) -> [UInt8] {
    let facets = conn.searchFilters()
    var w = JSONStreamWriter(capacity: 1024)
    w.beginObject()
    w.key("frameworks")
    w.beginArray()
    for framework in facets.frameworks {
      w.beginObject()
      w.key("label")
      w.string(framework.label)
      w.key("value")
      w.string(framework.value)
      w.endObject()
    }
    w.endArray()
    w.key("kinds")
    w.beginArray()
    for kind in facets.kinds { w.string(kind) }
    w.endArray()
    w.key("wwdcYears")
    w.beginArray()
    for year in facets.wwdcYears {
      w.beginObject()
      w.key("year")
      w.integer(year.year)
      w.key("count")
      w.integer(year.count)
      w.endObject()
    }
    w.endArray()
    w.endObject()
    return w.finish()
  }

  /// GET /api/fonts (fonts.route.js → projectListAppleFonts): `{families:[{id,
  /// files:[{id,file_name}]}]}`. The `name` key is never emitted — the schema has
  /// `display_name`, not `name`, so projectListAppleFonts omits it.
  static func fonts(_ conn: StorageConnection) -> [UInt8] {
    let families = conn.listAppleFonts().map { family in
      FontsResponse.Family(
        id: family.id,
        files: family.files.map { FontsResponse.File(id: $0.id, file_name: $0.fileName) })
    }
    return WebJSON.encode(FontsResponse(families: families))
  }

  /// GET /api/fonts/faces.css (fonts.route.js fontFacesCssHandler → buildFontFaceCss).
  static func fontFacesCss(_ conn: StorageConnection, baseUrl: String) -> [UInt8] {
    let families = conn.listAppleFonts()
    var rules: [String] = []
    for family in families {
      for file in family.files {
        let name = "apple-docs-\(family.id)-\(file.id)"
        let url = "\(baseUrl)/api/fonts/file/\(encodeURIComponent(file.id))"
        let format = formatHint(file.format)
        let formatClause = format.isEmpty ? "" : " format(\"\(format)\")"
        rules.append(
          "@font-face { font-family: \"\(name)\"; src: url(\"\(url)\")\(formatClause); font-display: swap; }"
        )
      }
    }
    return Array(rules.joined(separator: "\n").utf8)
  }

  /// GET /api/symbols/index.json (symbols-index.route.js → listCatalog). Built as
  /// `JSONValue` because codepoint/codepointVersion EMIT `null` (not omit).
  static func symbolsIndex(_ conn: StorageConnection) -> [UInt8] {
    let rows = conn.listSfSymbolsCatalog()
    let symbols: [JSONValue] = rows.map { row in
      .object([
        "name": .string(row.name),
        "scope": .string(row.scope),
        "categories": parsedArray(row.categoriesJson),
        "keywords": parsedArray(row.keywordsJson),
        "bitmapOnly": .bool((row.bitmapOnly ?? 0) != 0),
        "renderUnsupported": .bool((row.renderUnsupported ?? 0) != 0),
        "codepoint": intOrNull(row.codepoint),
        "codepointVersion": strOrNull(row.codepointVersion),
      ])
    }
    return encodeJSONValue(
      .object(["count": .number(Double(rows.count)), "symbols": .array(symbols)]))
  }

  /// GET /api/symbols/search (symbols.route.js → searchSfSymbols). `query` is the
  /// RAW q param (echoed un-trimmed); `scope` nil = all; `limit` already clamped.
  static func symbolsSearch(
    _ conn: StorageConnection, query: String, scope: String?, limit: Int
  ) -> [UInt8] {
    let results = conn.searchSfSymbols(query: query, scope: scope, limit: limit)
      .map { JSONValue.object(symbolRowObject($0)) }
    var obj: [String: JSONValue] = [:]
    obj["results"] = .array(results)
    obj["query"] = .string(query)
    obj["scope"] = scope.map { .string($0) } ?? .null
    return encodeJSONValue(.object(obj))
  }

  /// GET /api/symbols/<scope>/<name>.json (symbols.route.js → getSfSymbol). nil =
  /// 404. Adds `codepoint_display` when codepoint is set, else OMITs `codepoint` +
  /// `codepoint_display`.
  static func symbolMetadata(_ conn: StorageConnection, scope: String, name: String) -> [UInt8]? {
    guard let row = conn.getSfSymbol(scope: scope, name: name) else { return nil }
    var obj = symbolRowObject(row)
    if let cp = row.codepoint {
      obj["codepoint_display"] = .string(codepointDisplay(cp))
    } else {
      obj["codepoint"] = nil
    }
    return encodeJSONValue(.object(obj))
  }

  /// GET /data/search/title-index[.<hash>].json (search-data.route.js).
  static func titleIndexBytes(_ conn: StorageConnection) -> [UInt8] {
    WebJSON.encode(titleIndexResponse(conn.buildTitleIndex()))
  }

  /// GET /data/search/aliases[.<hash>].json — {alias: canonical} (a Dictionary,
  /// order-free under intrinsic).
  static func aliasMapBytes(_ conn: StorageConnection) -> [UInt8] {
    WebJSON.encode(conn.buildAliasMap())
  }

  /// GET /data/search/search-manifest.json (context.js getSearchManifest). The
  /// title-index/aliases filename hashes are `sha256(artifact-bytes).slice(0,10)` —
  /// ad-server's own bytes (self-coherent; differ from JS under intrinsic, D2).
  static func searchManifest(_ conn: StorageConnection) -> [UInt8] {
    let titleIndex = conn.buildTitleIndex()
    let aliasMap = conn.buildAliasMap()
    let titleBytes = WebJSON.encode(titleIndexResponse(titleIndex))
    let aliasBytes = WebJSON.encode(aliasMap)
    let manifest = SearchManifest(
      version: 2, titleCount: titleIndex.keys.count, aliasCount: aliasMap.count, shardCount: 0,
      files: [
        "title-index": "title-index.\(String(sha256HexLower(titleBytes).prefix(10))).json",
        "aliases": "aliases.\(String(sha256HexLower(aliasBytes).prefix(10))).json",
      ],
      generatedAt: ISO8601DateFormatter().string(from: Date()))
    return WebJSON.encode(manifest)
  }

  /// GET /readyz — instance readiness (the DB probe). Instance-identified shape
  /// (like /healthz), not parity-gated; 503 when the read pool can't answer.
  static func readyz(dbOk: Bool) -> WebResponse {
    var w = JSONStreamWriter(capacity: 96)
    w.beginObject()
    w.key("ok")
    w.bool(dbOk)
    w.key("service")
    w.string("ad-server")
    w.key("db")
    w.bool(dbOk)
    w.key("readerPool")
    w.null()
    w.endObject()
    return WebResponse(
      status: dbOk ? .ok : .serviceUnavailable,
      contentType: "application/json;charset=utf-8", cacheControl: "no-store", body: w.finish())
  }
}

/// CSS `format(...)` hint (src/web/lib/font-faces.js formatHint).
private func formatHint(_ format: String?) -> String {
  switch (format ?? "").lowercased() {
  case "ttf": return "truetype"
  case "otf": return "opentype"
  case "ttc": return "collection"
  default: return ""
  }
}

/// JS `encodeURIComponent` — the unreserved set `A-Za-z0-9-_.!~*'()` passes
/// through; every other byte becomes `%XX` (uppercase hex) over its UTF-8 bytes.
private func encodeURIComponent(_ s: String) -> String {
  let unreserved = Set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()".utf8)
  let hex: [UInt8] = Array("0123456789ABCDEF".utf8)
  var out: [UInt8] = []
  for b in s.utf8 {
    if unreserved.contains(b) {
      out.append(b)
    } else {
      out.append(UInt8(ascii: "%"))
      out.append(hex[Int(b >> 4)])
      out.append(hex[Int(b & 0xF)])
    }
  }
  return String(decoding: out, as: UTF8.self)
}

/// Encodes a `JSONValue` to bytes (ADJSON); `null` on the impossible throw.
private func encodeJSONValue(_ value: JSONValue) -> [UInt8] {
  (try? value.encoded()).map { Array($0) } ?? Array("null".utf8)
}

/// The full `sf_symbols` row as JS emits it (`...row` + the 4 parsed `*_json`):
/// every column verbatim (`bitmap_only`/`render_unsupported` stay 0/1 ints), then
/// the parsed categories/keywords/aliases/availability.
private func symbolRowObject(_ row: SfSymbolRow) -> [String: JSONValue] {
  var obj: [String: JSONValue] = [:]
  obj["name"] = .string(row.name)
  obj["scope"] = .string(row.scope)
  obj["categories_json"] = strOrNull(row.categoriesJson)
  obj["keywords_json"] = strOrNull(row.keywordsJson)
  obj["aliases_json"] = strOrNull(row.aliasesJson)
  obj["availability_json"] = strOrNull(row.availabilityJson)
  obj["order_index"] = intOrNull(row.orderIndex)
  obj["bundle_path"] = strOrNull(row.bundlePath)
  obj["bundle_version"] = strOrNull(row.bundleVersion)
  obj["updated_at"] = strOrNull(row.updatedAt)
  obj["codepoint"] = intOrNull(row.codepoint)
  obj["codepoint_version"] = strOrNull(row.codepointVersion)
  obj["bitmap_only"] = intOrNull(row.bitmapOnly)
  obj["render_unsupported"] = intOrNull(row.renderUnsupported)
  obj["categories"] = parsedArray(row.categoriesJson)
  obj["keywords"] = parsedArray(row.keywordsJson)
  obj["aliases"] = parsedArray(row.aliasesJson)
  obj["availability"] = parsedValue(row.availabilityJson)
  return obj
}

private func strOrNull(_ s: String?) -> JSONValue { s.map { JSONValue.string($0) } ?? .null }
private func intOrNull(_ n: Int64?) -> JSONValue { n.map { JSONValue.number(Double($0)) } ?? .null }

/// parseJsonArray: the parsed value if it's an array, else `[]`.
private func parsedArray(_ json: String?) -> JSONValue {
  guard let json, let v = try? JSONValue(parsing: json), case .array = v else { return .array([]) }
  return v
}

/// parseJsonValue: the parsed value, or `null`.
private func parsedValue(_ json: String?) -> JSONValue {
  guard let json, let v = try? JSONValue(parsing: json) else { return .null }
  return v
}

/// `U+XXXX` (symbols.route.js: `codepoint.toString(16).toUpperCase().padStart(4,'0')`).
private func codepointDisplay(_ cp: Int64) -> String {
  let hex = String(cp, radix: 16, uppercase: true)
  let padded = hex.count < 4 ? String(repeating: "0", count: 4 - hex.count) + hex : hex
  return "U+\(padded)"
}

/// Matches `^/api/symbols/(public|private)/(.+)\.json$` → (scope, decoded name).
func matchSymbolMetadataPath(_ path: Substring) -> (scope: String, name: String)? {
  for scope in ["public", "private"] {
    let prefix = "/api/symbols/\(scope)/"
    guard path.hasPrefix(prefix), path.hasSuffix(".json") else { continue }
    let nameStart = path.index(path.startIndex, offsetBy: prefix.count)
    let nameEnd = path.index(path.endIndex, offsetBy: -5)
    guard nameStart < nameEnd else { continue }
    return (scope, percentDecode(String(path[nameStart..<nameEnd])))
  }
  return nil
}

private func titleIndexResponse(_ ti: TitleIndex) -> TitleIndexResponse {
  TitleIndexResponse(
    v: 2, frameworks: ti.frameworks, keys: ti.keys, titles: ti.titles, abstracts: ti.abstracts,
    fwIndices: ti.fwIndices, kinds: ti.kinds, roleHeadings: ti.roleHeadings)
}

/// Matches `^/data/search/(title-index|aliases)\.[0-9a-f]{10}\.json$` → the base
/// name. The <hash> is cache-busting only — the route serves the CURRENT artifact
/// (search-data.route.js searchHashedArtifactHandler).
func matchHashedSearchArtifact(_ path: Substring) -> String? {
  for base in ["title-index", "aliases"] {
    let prefix = "/data/search/\(base)."
    guard path.hasPrefix(prefix), path.hasSuffix(".json") else { continue }
    let hashStart = path.index(path.startIndex, offsetBy: prefix.count)
    let hashEnd = path.index(path.endIndex, offsetBy: -5)
    let hash = path[hashStart..<hashEnd]
    guard hash.count == 10,
      hash.allSatisfy({ ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f") })
    else { continue }
    return base
  }
  return nil
}
