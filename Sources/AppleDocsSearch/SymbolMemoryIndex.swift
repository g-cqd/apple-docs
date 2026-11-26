import AemiSearch
public import AppleDocsCore

/// In-memory `AemiSearch` hot-path symbol/title index supporting typo-tolerant BM25 + trigram lookup
/// and checksummed binary snapshot persistence.
///
/// Complements SQLite FTS5 by offering sub-millisecond in-process fuzzy/substring identifier search
/// (e.g. `NavStack`, `navigaton`, `ViewModifier`) with `AemiSearch`'s keyed-hash term interner and
/// CamelCase identifier tokenizer.
public final class SymbolMemoryIndex {
    private let index: SearchIndex
    private var keyByNumber: [DocumentKey] = []

    /// Creates an empty in-memory symbol index.
    public init() {
        self.index = SearchIndex()
    }

    /// Restores a previously serialized `SymbolMemoryIndex` snapshot.
    public init(serialized bytes: [UInt8]) throws {
        let restored = try SearchIndex(serialized: bytes)
        self.index = restored
        var keys: [DocumentKey] = []
        keys.reserveCapacity(restored.count)
        for docID in 0 ..< UInt32(restored.count) {
            if let entry = restored.document(docID), let rawKey = entry.fields["key"] {
                keys.append(try DocumentKey(rawKey))
            }
        }
        self.keyByNumber = keys
    }

    /// Number of indexed symbols/documents.
    public var count: Int { index.count }

    /// Adds a ``DocumentRecord``'s title, key, framework, and abstract to the in-memory index.
    public func add(_ document: DocumentRecord) {
        var parts = [document.title, document.key.rawValue]
        if let abstract = document.abstractText, !abstract.isEmpty {
            parts.append(abstract)
        }
        var fields: [String: String] = [
            "key": document.key.rawValue,
            "framework": document.framework,
            "source": document.sourceType.rawValue
        ]
        if let kind = document.kind { fields["kind"] = kind }
        let entry = SearchDocument(text: parts.joined(separator: " "), fields: fields, time: 0)
        index.add(entry)
        keyByNumber.append(document.key)
    }

    /// Queries the in-memory `AemiSearch` index, returning `(DocumentKey, BM25 score)` pairs.
    public func search(
        _ query: String,
        framework: String? = nil,
        limit: Int = 25,
        expands: Bool = true
    ) -> [(key: DocumentKey, score: Double)] {
        var fields: [String: String] = [:]
        if let framework { fields["framework"] = framework.lowercased() }
        let hits = index.search(SearchQuery(query, fields: fields, limit: limit, expands: expands))
        return hits.compactMap { hit in
            let idx = Int(hit.document)
            guard idx >= 0, idx < keyByNumber.count else { return nil }
            return (keyByNumber[idx], hit.score)
        }
    }

    /// Serializes the index into `AemiSearch`'s checksummed binary snapshot format.
    public func serialized() -> [UInt8] {
        index.serialized()
    }
}
