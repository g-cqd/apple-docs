/// Site-wide settings for the web UI and static export.
public struct WebSiteConfiguration: Hashable, Sendable {
    /// Absolute public origin used for sitemap `<loc>` URLs, without a trailing slash.
    public let baseURL: String

    /// - Parameter baseURL: an `http(s)://` origin (optionally with a path prefix); anything else falls back
    ///   to `http://127.0.0.1:3134` so sitemaps never carry attacker-chosen schemes.
    public init(baseURL: String = "http://127.0.0.1:3134") {
        var trimmed = Substring(baseURL)
        while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
        let lowered = trimmed.lowercased()
        let valid =
            (lowered.hasPrefix("http://") || lowered.hasPrefix("https://"))
            && !trimmed.contains(where: { $0.isWhitespace || $0 == "<" || $0 == ">" || $0 == "\"" })
        self.baseURL = valid ? String(trimmed) : "http://127.0.0.1:3134"
    }
}
