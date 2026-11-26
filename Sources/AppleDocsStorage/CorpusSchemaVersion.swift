/// Storage schema versions supported by `AppleDocsStorage`.
public enum CorpusSchemaVersion: Int, Hashable, Sendable, Comparable {
    /// Clean Swift-native schema v1 (authoritative target for new builds).
    case swiftV1 = 1
    /// Legacy Bun corpus schema v31 (supported via the read-only importer).
    case legacyBunV31 = 31

    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}
