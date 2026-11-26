/// Public three-level search confidence collapsed from internal retrieval tiers.
public enum SearchConfidence: String, Hashable, Sendable, Codable {
    case exact
    case partial
    case approximate
}
