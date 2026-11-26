public import AppleDocsCore

/// Ranked search result returned by ``CorpusSearchEngine``.
///
/// Wraps the canonical ``DocumentRecord`` alongside its stable storage ID, relevance score,
/// and collapsed three-level ``SearchConfidence``.
public struct CorpusSearchHit: Hashable, Sendable {
    public let documentID: Int64
    public let document: DocumentRecord
    public let score: Double
    public let confidence: SearchConfidence

    public init(
        documentID: Int64,
        document: DocumentRecord,
        score: Double,
        confidence: SearchConfidence
    ) {
        self.documentID = documentID
        self.document = document
        self.score = score
        self.confidence = confidence
    }
}
