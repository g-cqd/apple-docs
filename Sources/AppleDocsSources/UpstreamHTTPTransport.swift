/// Injectable cross-platform outbound HTTP transport abstraction.
///
/// Production code uses ``NativeUpstreamTransport`` (`g-cqd/HTTP`'s `HTTPClient`); tests inject deterministic in-memory transports
/// with zero real network calls or sleeps.
public protocol UpstreamHTTPTransport: Sendable {
    /// Performs a single outbound HTTP GET with no automatic retries.
    func fetch(_ request: UpstreamFetchRequest) async throws(SourceError) -> UpstreamFetchResponse
}
