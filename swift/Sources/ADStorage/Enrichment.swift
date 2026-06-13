// Snippet / relatedCount enrichment queries (RFC 0001 P6, phase 2). Ports the
// batched getDocumentSnippetData + getRelatedDocCounts from
// src/storage/repos/documents.js, plus the type-directed section codec
// (src/storage/section-codec.js): a section's content_text is used as-is when
// stored TEXT, or zstd-inflated when stored as a magic-prefixed BLOB (the
// `storage compact` profile). Best-effort: a missing table → empty result, so a
// lite-tier corpus never sinks a search response.

import ADArchive

public struct SnippetSection: Sendable {
  public let heading: String?
  public let contentText: String?
  public let sortOrder: Double
}

public struct SnippetDoc: Sendable {
  public let title: String?
  public let abstractText: String?
  public let declarationText: String?
  public let headings: String?
  public let sections: [SnippetSection]
}

extension StorageConnection {
  /// Batched documents + their (codec-decoded) sections, keyed by document key.
  /// Empty when no keys or the documents table is unavailable.
  public func getDocumentSnippetData(_ keys: [String]) -> [String: SnippetDoc] {
    guard !keys.isEmpty else { return [:] }
    let docSQL =
      "SELECT id, key, title, abstract_text, declaration_text, headings FROM documents WHERE key IN (\(placeholders(keys.count)))"
    guard let docStmt = conn.prepareUncached(docSQL) else { return [:] }
    for (i, key) in keys.enumerated() { docStmt.bindText(Int32(i + 1), key) }

    var fields: [String: SnippetDoc] = [:]
    var idToKey: [Int64: String] = [:]
    while docStmt.step() == SQLite.row {
      let id = docStmt.int(0) ?? 0
      let key = docStmt.text(1) ?? ""
      idToKey[id] = key
      fields[key] = SnippetDoc(
        title: docStmt.text(2), abstractText: docStmt.text(3), declarationText: docStmt.text(4),
        headings: docStmt.text(5), sections: [])
    }

    guard conn.hasSections, !idToKey.isEmpty else { return fields }

    let ids = Array(idToKey.keys)
    let secSQL =
      "SELECT document_id, heading, content_text, sort_order FROM document_sections WHERE document_id IN (\(placeholders(ids.count))) ORDER BY sort_order"
    guard let secStmt = conn.prepareUncached(secSQL) else { return fields }
    for (i, id) in ids.enumerated() { secStmt.bindInt64(Int32(i + 1), id) }
    var sectionsByKey: [String: [SnippetSection]] = [:]
    while secStmt.step() == SQLite.row {
      let docId = secStmt.int(0) ?? 0
      guard let key = idToKey[docId] else { continue }
      sectionsByKey[key, default: []].append(
        SnippetSection(
          heading: secStmt.text(1), contentText: decodeSectionContent(secStmt, 2),
          sortOrder: secStmt.double(3) ?? 0))
    }

    var out: [String: SnippetDoc] = [:]
    out.reserveCapacity(fields.count)
    for (key, doc) in fields {
      out[key] = SnippetDoc(
        title: doc.title, abstractText: doc.abstractText, declarationText: doc.declarationText,
        headings: doc.headings, sections: sectionsByKey[key] ?? [])
    }
    return out
  }

  /// Count of relationships originating from each key. Returns nil when the
  /// document_relationships table is ABSENT — mirroring JS where the unguarded
  /// query throws and the search-time try/catch then skips ALL enrichment (so
  /// neither relatedCount NOR snippet is emitted). Empty keys → empty map (JS
  /// early-returns before touching the table).
  public func getRelatedDocCounts(_ keys: [String]) -> [String: Int]? {
    if keys.isEmpty { return [:] }
    guard conn.hasRelationships else { return nil }
    let sql =
      "SELECT from_key, COUNT(*) FROM document_relationships WHERE from_key IN (\(placeholders(keys.count))) GROUP BY from_key"
    guard let stmt = conn.prepareUncached(sql) else { return nil }
    for (i, key) in keys.enumerated() { stmt.bindText(Int32(i + 1), key) }
    var out: [String: Int] = [:]
    while stmt.step() == SQLite.row {
      if let key = stmt.text(0) { out[key] = Int(stmt.int(1) ?? 0) }
    }
    return out
  }
}

/// Type-directed section content decode (section-codec.js decodeSectionContent):
/// TEXT passes through; a BLOB with the 4-byte zstd magic is inflated; any other
/// BLOB is a best-effort UTF-8 decode.
private func decodeSectionContent(_ stmt: PreparedStatement, _ col: Int32) -> String? {
  switch stmt.columnType(col) {
  case SQLite.typeNull: return nil
  case SQLite.typeText: return stmt.text(col)
  default:
    guard let bytes = stmt.blob(col) else { return nil }
    if bytes.isEmpty { return "" }
    if bytes.count >= 4, bytes[0] == 0x28, bytes[1] == 0xB5, bytes[2] == 0x2F, bytes[3] == 0xFD,
      let inflated = ZstdDecoder.decompress(bytes)
    {
      return String(decoding: inflated, as: UTF8.self)
    }
    return String(decoding: bytes, as: UTF8.self)
  }
}

func placeholders(_ count: Int) -> String {
  Array(repeating: "?", count: count).joined(separator: ",")
}
