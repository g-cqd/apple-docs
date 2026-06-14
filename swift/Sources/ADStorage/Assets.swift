// Asset queries for the /api/fonts + /api/symbols routes (RFC 0001 P6 web slice).
// Ports src/storage/repos/{assets-fonts,assets-symbols}.js. Storage returns typed
// rows (the D5 model seam); ADServer frames the JSON/CSS.

public struct AppleFontFile: Sendable {
  public let id: String
  public let fileName: String
  public let format: String?
}

public struct AppleFontFamily: Sendable {
  public let id: String
  public let files: [AppleFontFile]
}

extension StorageConnection {
  /// families ⋈ files (assets-fonts.js `listFonts`): families ORDER BY display_name,
  /// each family's files in (family_id, file_name) order. [] when the tables are absent.
  public func listAppleFonts() -> [AppleFontFamily] {
    guard
      let famStmt = conn.prepareUncached("SELECT id FROM apple_font_families ORDER BY display_name")
    else { return [] }
    var familyIds: [String] = []
    while famStmt.step() == SQLite.row {
      if let id = famStmt.text(0) { familyIds.append(id) }
    }
    guard
      let fileStmt = conn.prepareUncached(
        "SELECT family_id, id, file_name, format FROM apple_font_files ORDER BY family_id, file_name")
    else {
      return familyIds.map { AppleFontFamily(id: $0, files: []) }
    }
    var byFamily: [String: [AppleFontFile]] = [:]
    while fileStmt.step() == SQLite.row {
      guard let familyId = fileStmt.text(0), let id = fileStmt.text(1), let fileName = fileStmt.text(2)
      else { continue }
      byFamily[familyId, default: []].append(
        AppleFontFile(id: id, fileName: fileName, format: fileStmt.text(3)))
    }
    return familyIds.map { AppleFontFamily(id: $0, files: byFamily[$0] ?? []) }
  }
}
