public import AppleDocsCore

/// Result of a single source page fetch supporting conditional `304 Not Modified` skips and `404` tombstones.
public enum SourceFetchOutcome: Hashable, Sendable {
    case modified(payload: SourcePayload, etag: String?, discoveredKeys: [DocumentKey])
    case notModified
    case notFound
}
