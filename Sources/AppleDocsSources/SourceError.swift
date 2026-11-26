/// Typed errors emitted by upstream HTTP fetching and source adapters.
public enum SourceError: Error, Hashable, Sendable {
    case unsafeURL(String, reason: String)
    case responseTooLarge(limitBytes: Int)
    case httpStatus(Int, url: String)
    case retryExhausted(url: String, lastStatus: Int?)
    case networkFailure(String)
    case unknownSource(String)
}
