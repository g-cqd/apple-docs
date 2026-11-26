public import AppleDocsCore

/// Uniform cross-platform contract implemented by every upstream documentation source adapter.
public protocol SourceAdapter: Sendable {
    /// Canonical identifier of the source this adapter ingests.
    var kind: SourceKind { get }
    /// Human-readable name displayed in progress and status output.
    var displayName: String { get }
    /// Default documentation root metadata for this source.
    var defaultRoot: CorpusRootRecord { get }
    /// Initial seed keys to enqueue when starting a fresh discovery crawl.
    var seedKeys: [DocumentKey] { get }
    /// Resolves the canonical public HTTPS URL for fetching `key`.
    func dataURL(for key: DocumentKey) throws(SourceError) -> String
    /// Discovers the roots and initial keys for this source (`nil` / default uses `defaultRoot` + `seedKeys`).
    func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery
    /// Fetches and packages `key` using `client`, returning `.notModified` on HTTP 304 or `.notFound` on 404/410.
    func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome
}

extension SourceAdapter {
    public func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery {
        SourceDiscovery(roots: [defaultRoot], keys: seedKeys)
    }
}
