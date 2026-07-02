// Search-data artifacts for /data/search/*. Builds the title index and
// alias map. The manifest + the hashed filenames are framed in ADServer (it
// owns the SHA-256). The alias map is order-free → a plain dictionary.

/// The columnar v2 title index. The parallel arrays are in `ORDER BY key`;
/// `frameworks` is the sorted distinct set.
public struct TitleIndex: Sendable {
    public let frameworks: [String]
    public let keys: [String]
    public let titles: [String]
    public let abstracts: [String]
    public let fwIndices: [Int]
    public let kinds: [String]
    public let roleHeadings: [String]
}

/// JS `String.prototype.slice(0, n)` over UTF-16 code units (abstracts cap).
private func utf16Slice(_ s: String, _ n: Int) -> String {
    String(decoding: Array(s.utf16.prefix(n)), as: UTF16.self)
}

extension StorageConnection {
    public func buildTitleIndex() -> TitleIndex {
        let empty = TitleIndex(
            frameworks: [], keys: [], titles: [], abstracts: [], fwIndices: [], kinds: [],
            roleHeadings: [])
        guard
            let stmt = conn.prepareUncached(
                "SELECT key, title, abstract_text, framework, kind, role_heading FROM documents ORDER BY key")
        else { return empty }
        var keys: [String] = []
        var titles: [String] = []
        var abstracts: [String] = []
        var docFrameworks: [String?] = []
        var kinds: [String] = []
        var roleHeadings: [String] = []
        while stmt.step() == SQLite.row {
            keys.append(stmt.text(0) ?? "")
            titles.append(stmt.text(1) ?? "")
            abstracts.append(utf16Slice(stmt.text(2) ?? "", 80))
            docFrameworks.append(stmt.text(3))
            kinds.append(stmt.text(4) ?? "")
            roleHeadings.append(stmt.text(5) ?? "")
        }
        // frameworks: distinct non-empty, then JS `.sort()` (ASCII slugs → identical).
        var seen = Set<String>()
        var frameworks: [String] = []
        for fw in docFrameworks {
            if let fw, !fw.isEmpty, seen.insert(fw).inserted { frameworks.append(fw) }
        }
        frameworks.sort()
        var fwLookup: [String: Int] = [:]
        for (i, fw) in frameworks.enumerated() { fwLookup[fw] = i }
        let fwIndices = docFrameworks.map { fw in fw.flatMap { fwLookup[$0] } ?? -1 }
        return TitleIndex(
            frameworks: frameworks, keys: keys, titles: titles, abstracts: abstracts,
            fwIndices: fwIndices, kinds: kinds, roleHeadings: roleHeadings)
    }

    /// {alias: canonical} — order-free.
    public func buildAliasMap() -> [String: String] {
        guard let stmt = conn.prepareUncached("SELECT canonical, alias FROM framework_synonyms")
        else { return [:] }
        var out: [String: String] = [:]
        while stmt.step() == SQLite.row {
            if let canonical = stmt.text(0), let alias = stmt.text(1) { out[alias] = canonical }
        }
        return out
    }

    /// `SELECT canonical, alias FROM framework_synonyms` in ROW ORDER — the S3
    /// static build serializes the alias map with `JSON.stringify` insertion
    /// semantics, so the order the JS `for (const {canonical, alias} of synonyms)`
    /// loop saw must be preserved (buildAliasMap above is the order-free runtime
    /// read).
    public func aliasEntries() -> [AliasEntry] {
        guard let stmt = conn.prepareUncached("SELECT canonical, alias FROM framework_synonyms")
        else { return [] }
        var out: [AliasEntry] = []
        while stmt.step() == SQLite.row {
            if let canonical = stmt.text(0), let alias = stmt.text(1) {
                out.append(AliasEntry(alias: alias, canonical: canonical))
            }
        }
        return out
    }

    /// The body-shard source (buildBodyShards' reads): every document in
    /// `ORDER BY id` with its accumulated body preview — section text in
    /// `ORDER BY document_id, sort_order, id`, pieces joined with a single
    /// space, accumulation short-circuiting once the JS `.length` (UTF-16
    /// units) reaches 500, then trimmed and capped at 500 units. The JS batched
    /// its section reads in 5 000-doc `IN` windows purely as a memory fix; a
    /// single ordered stream visits the identical row sequence.
    public func bodyPreviewSource() -> BodyPreviewSource {
        var docs: [(id: Int64, key: String, framework: String?)] = []
        if let stmt = conn.prepareUncached("SELECT id, key, framework FROM documents ORDER BY id") {
            while stmt.step() == SQLite.row {
                docs.append((id: stmt.int(0) ?? 0, key: stmt.text(1) ?? "", framework: stmt.text(2)))
            }
        }
        guard hasTable("document_sections") else {
            return BodyPreviewSource(
                hasSections: false,
                docs: docs.map { BodyPreviewDoc(key: $0.key, framework: $0.framework, body: "") })
        }

        var bodies: [Int64: (text: String, units: Int)] = [:]
        if let stmt = conn.prepareUncached(
            "SELECT document_id, content_text FROM document_sections ORDER BY document_id, sort_order, id")
        {
            while stmt.step() == SQLite.row {
                let docId = stmt.int(0) ?? 0
                // JS: `if (existing.length >= BODY_PREVIEW_CHARS) continue` —
                // checked BEFORE appending, so one piece may overflow the cap.
                if let existing = bodies[docId], existing.units >= 500 { continue }
                guard let piece = decodeSectionColumn(stmt, 1), !piece.isEmpty else { continue }
                if var existing = bodies[docId] {
                    existing.text += " \(piece)"
                    existing.units += 1 + piece.utf16.count
                    bodies[docId] = existing
                } else {
                    bodies[docId] = (text: piece, units: piece.utf16.count)
                }
            }
        }

        let out = docs.map { doc in
            let body = jsTrim(bodies[doc.id]?.text ?? "")
            return BodyPreviewDoc(key: doc.key, framework: doc.framework, body: utf16Slice(body, 500))
        }
        return BodyPreviewSource(hasSections: true, docs: out)
    }
}

/// One `framework_synonyms` row, in table order.
public struct AliasEntry: Sendable {
    public let alias: String
    public let canonical: String
    public init(alias: String, canonical: String) {
        self.alias = alias
        self.canonical = canonical
    }
}

/// One document's shard input: key, framework, accumulated body preview
/// (empty when the doc has no section text — or on a lite-tier corpus).
public struct BodyPreviewDoc: Sendable {
    public let key: String
    public let framework: String?
    public let body: String
    public init(key: String, framework: String?, body: String) {
        self.key = key
        self.framework = framework
        self.body = body
    }
}

/// buildBodyShards' corpus reads + the `document_sections` presence flag.
public struct BodyPreviewSource: Sendable {
    public let hasSections: Bool
    public let docs: [BodyPreviewDoc]
    public init(hasSections: Bool, docs: [BodyPreviewDoc]) {
        self.hasSections = hasSections
        self.docs = docs
    }
}

/// `String.prototype.trim()` — strip the JS whitespace set at both ends.
private func jsTrim(_ s: String) -> String {
    let scalars = Array(s.unicodeScalars)
    var start = 0
    var end = scalars.count
    while start < end, isJsWhitespaceScalar(scalars[start]) { start += 1 }
    while end > start, isJsWhitespaceScalar(scalars[end - 1]) { end -= 1 }
    if start == 0 && end == scalars.count { return s }
    var view = String.UnicodeScalarView()
    view.append(contentsOf: scalars[start..<end])
    return String(view)
}

/// The JS `\s` / trim whitespace set (ASCII + NBSP + Unicode space separators +
/// LS/PS + BOM).
private func isJsWhitespaceScalar(_ s: Unicode.Scalar) -> Bool {
    switch s.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029,
        0x202F, 0x205F, 0x3000, 0xFEFF:
        return true
    default:
        return false
    }
}
