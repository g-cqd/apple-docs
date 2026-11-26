import AppleDocsCore
public import AppleDocsStorage

/// Semantic binary-shortlist + hybrid lexical/semantic fusion over `document_vectors` and `Model2VecEmbedder`.
///
/// Packs all document binary signatures into one contiguous byte buffer so scanning 393k vectors
/// is a single cache-friendly pass over ~25 MiB using ``BinaryVectorScorer/shortlist(query:packedCodes:codeByteWidth:topK:)``,
/// then fuses lexical + semantic rankings via ``HybridRankFusion``.
public final class SemanticCorpusIndex: Sendable {
    public let documentIDs: [Int64]
    public let packedCodes: [UInt8]
    public let codeByteWidth: Int

    public init(documentIDs: [Int64], packedCodes: [UInt8], codeByteWidth: Int) {
        self.documentIDs = documentIDs
        self.packedCodes = packedCodes
        self.codeByteWidth = codeByteWidth
    }

    /// Loads packed binary document vectors from `document_vectors` in one SQLite scan.
    public static func load(from connection: SQLiteConnection) throws(SQLiteError) -> Self {
        let rows = try connection.query("SELECT document_id, vec FROM document_vectors ORDER BY document_id")
        var ids: [Int64] = []
        var packed: [UInt8] = []
        var width = 0
        ids.reserveCapacity(rows.count)
        for row in rows {
            guard let vec = try row.optionalBlob(at: 1), !vec.isEmpty else { continue }
            if width == 0 {
                width = vec.count
                packed.reserveCapacity(rows.count * width)
            }
            guard vec.count == width else { continue }
            ids.append(try row.integer(at: 0))
            packed.append(contentsOf: vec)
        }
        return Self(documentIDs: ids, packedCodes: packed, codeByteWidth: width)
    }

    /// Returns the `topK` closest `(documentID, similarity)` entries for `queryVector`.
    public func shortlist(for queryVector: [Float], topK: Int = 50) -> [(documentID: Int64, similarity: Double)] {
        guard codeByteWidth > 0, !documentIDs.isEmpty else { return [] }
        let queryCode = BinaryVectorScorer.quantizeBinary(queryVector)
        guard queryCode.count == codeByteWidth else { return [] }
        let totalBits = Double(codeByteWidth * 8)
        return
            BinaryVectorScorer.shortlist(
                query: queryCode,
                packedCodes: packedCodes,
                codeByteWidth: codeByteWidth,
                topK: topK
            )
            .map { entry in
                (documentIDs[entry.index], 1.0 - Double(entry.distance) / totalBits)
            }
    }

    /// Runs hybrid lexical + semantic retrieval and fuses candidates via score-aware RRF.
    public func hybridSearch(
        _ request: CorpusSearchRequest,
        embedder: Model2VecEmbedder,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [CorpusSearchHit] {
        let lexical = try CorpusSearchEngine.search(request, on: connection)
        if lexical.first?.confidence == .exact, lexical.count >= request.limit {
            return lexical
        }

        let queryVec = embedder.embed(request.query)
        let semMatches = shortlist(for: queryVec, topK: max(request.limit * 2, 25))
        guard !semMatches.isEmpty else { return lexical }

        let semIDs = semMatches.map(\.documentID)
        let placeholders = Array(repeating: "?", count: semIDs.count).joined(separator: ", ")
        let rows = try connection.query(
            "SELECT d.id, \(CorpusStore.documentColumnList) FROM documents d WHERE d.id IN (\(placeholders))",
            bindings: semIDs.map(SQLiteValue.integer)
        )
        var byKey: [String: CorpusSearchHit] = [:]
        for hit in lexical { byKey[hit.document.key.rawValue] = hit }

        var semKeys: [String] = []
        var semScores: [String: Double] = [:]
        var docByID: [Int64: DocumentRecord] = [:]
        for row in rows {
            let id = try row.integer(at: 0)
            docByID[id] = try CorpusStore.decodeDocument(row, offset: 1)
        }
        for match in semMatches {
            guard let doc = docByID[match.documentID] else { continue }
            if let fw = request.framework?.lowercased(), doc.framework != fw { continue }
            let k = doc.key.rawValue
            semKeys.append(k)
            semScores[k] = match.similarity
            if byKey[k] == nil {
                byKey[k] = CorpusSearchHit(
                    documentID: match.documentID,
                    document: doc,
                    score: match.similarity,
                    confidence: .approximate
                )
            }
        }

        let lexKeys = lexical.map(\.document.key.rawValue)
        let lexScores = Dictionary(uniqueKeysWithValues: lexical.map { ($0.document.key.rawValue, $0.score) })
        let fused = HybridRankFusion.fuse([
            HybridRankFusion.RankedList(keys: lexKeys, weight: 1.0, scores: lexScores),
            HybridRankFusion.RankedList(keys: semKeys, weight: 0.65, scores: semScores)
        ])
        return
            fused
            .sorted { $0.value > $1.value }
            .prefix(request.limit)
            .compactMap { byKey[$0.key] }
    }
}
