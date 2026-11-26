/// Injectable cross-platform outbound HTTP transport abstraction.
///
/// Production code uses ``URLSessionUpstreamTransport`` (until `g-cqd/HTTP` gains a native
/// outbound `HTTPClient` product per ADR-0002); tests inject deterministic in-memory transports
/// with zero real network calls or sleeps.
public protocol UpstreamHTTPTransport: Sendable {
    /// Performs a single outbound HTTP GET with no automatic retries.
    func fetch(_ request: UpstreamFetchRequest) async throws(SourceError) -> UpstreamFetchResponse
}
