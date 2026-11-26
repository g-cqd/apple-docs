public import AppleDocsCore

/// Roots and corpus keys discovered by a ``SourceAdapter`` before the crawl pool runs.
public struct SourceDiscovery: Hashable, Sendable {
    public let roots: [CorpusRootRecord]
    public let keys: [DocumentKey]
    /// When `true` (e.g. curated `packages` subset), keys absent from `keys` are not marked stale.
    public let isPartial: Bool

    public init(roots: [CorpusRootRecord], keys: [DocumentKey], isPartial: Bool = false) {
        self.roots = roots
        self.keys = keys
        self.isPartial = isPartial
    }
}
