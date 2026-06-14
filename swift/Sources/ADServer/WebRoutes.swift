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
