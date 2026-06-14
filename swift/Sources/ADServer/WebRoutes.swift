// JSON framing for the in-process web routes (RFC 0001 P6 web slice). Each
// builder emits bytes byte-identical to the Bun handler's `Response.json(...)`
// body via the streaming writer (caller-ordered keys). Storage stays typed
// (ADStorage returns facets/rows); presentation lives here.

import ADJSON
import ADStorage

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
