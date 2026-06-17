// Filter facets for GET /api/filters. wwdcYears: `json_extract` over
// malformed `source_metadata` errors mid-step, so the whole facet degrades
// to [] rather than failing the response.

public struct FrameworkFacet: Sendable {
  public let label: String
  public let value: String
}

public struct YearFacet: Sendable {
  public let year: Int64
  public let count: Int64
}

public struct FilterFacets: Sendable {
  public let frameworks: [FrameworkFacet]
  public let kinds: [String]
  public let wwdcYears: [YearFacet]
}

extension StorageConnection {
  public func searchFilters() -> FilterFacets {
    FilterFacets(
      frameworks: frameworkFacets(), kinds: kindFacets(), wwdcYears: wwdcYearFacets())
  }

  /// `SELECT 1` liveness probe (GET /readyz).
  public func probe() -> Bool {
    guard let stmt = conn.prepareUncached("SELECT 1") else { return false }
    return stmt.step() == SQLite.row
  }

  private func frameworkFacets() -> [FrameworkFacet] {
    let sql = """
      SELECT DISTINCT COALESCE(r.display_name, d.framework) as label, d.framework as value
      FROM documents d LEFT JOIN roots r ON r.slug = d.framework
      WHERE d.framework IS NOT NULL ORDER BY label
      """
    guard let stmt = conn.prepareUncached(sql) else { return [] }
    var out: [FrameworkFacet] = []
    while stmt.step() == SQLite.row {
      guard let label = stmt.text(0), let value = stmt.text(1) else { continue }
      out.append(FrameworkFacet(label: label, value: value))
    }
    return out
  }

  private func kindFacets() -> [String] {
    let sql =
      "SELECT DISTINCT role_heading FROM documents WHERE role_heading IS NOT NULL ORDER BY role_heading"
    guard let stmt = conn.prepareUncached(sql) else { return [] }
    var out: [String] = []
    while stmt.step() == SQLite.row {
      if let v = stmt.text(0) { out.append(v) }
    }
    return out
  }

  private func wwdcYearFacets() -> [YearFacet] {
    let sql = """
      SELECT CAST(json_extract(source_metadata, '$.year') AS INTEGER) as year, COUNT(*) as count
      FROM documents
      WHERE source_type = 'wwdc' AND json_extract(source_metadata, '$.year') IS NOT NULL
      GROUP BY year ORDER BY year DESC
      """
    guard let stmt = conn.prepareUncached(sql) else { return [] }
    var out: [YearFacet] = []
    while true {
      let rc = stmt.step()
      if rc == SQLite.done { break }
      // A json_extract error on malformed source_metadata surfaces as a non-row
      // rc mid-iteration → discard everything (the JS `.all()` throws → []).
      guard rc == SQLite.row else { return [] }
      guard let year = stmt.int(0), let count = stmt.int(1) else { continue }
      out.append(YearFacet(year: year, count: count))
    }
    return out
  }
}
