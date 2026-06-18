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
}
