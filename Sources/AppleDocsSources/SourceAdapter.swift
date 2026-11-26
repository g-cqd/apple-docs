public import AppleDocsCore

/// Uniform contract implemented by each upstream documentation source adapter.
public protocol SourceAdapter: Sendable {
    /// Canonical identifier of the source this adapter ingests.
    var kind: SourceKind { get }
    /// Human-readable name displayed in progress and status output.
    var displayName: String { get }
}
