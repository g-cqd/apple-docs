import Foundation

/// Site-wide settings for the web UI and static export.
public struct WebSiteConfiguration: Hashable, Sendable {
    /// Absolute public origin used for sitemap `<loc>` URLs, without a trailing slash.
    public let baseURL: String
    /// The path the site is mounted under (`/apple-docs` for `https://host/apple-docs`), empty at the root.
    public let basePath: String

    /// - Parameter baseURL: an `http(s)://` origin (optionally with a path prefix); anything else falls back
    ///   to `http://127.0.0.1:3134` so sitemaps never carry attacker-chosen schemes.
    public init(baseURL: String = "http://127.0.0.1:3134") {
        var trimmed = Substring(baseURL)
        while trimmed.hasSuffix("/") { trimmed = trimmed.dropLast() }
        let lowered = trimmed.lowercased()
        let valid =
            (lowered.hasPrefix("http://") || lowered.hasPrefix("https://"))
            && !trimmed.contains(where: { $0.isWhitespace || "<>\"'?#&\\".contains($0) })
        self.baseURL = valid ? String(trimmed) : "http://127.0.0.1:3134"
        self.basePath = Self.path(of: self.baseURL)
    }

    /// Rewrites every root-relative URL attribute (`href="/…"`, `src="/…"`, `action="/…"`) under ``basePath``.
    ///
    /// Safe on rendered pages because all dynamic text is HTML-escaped: a literal `="/` can only come from
    /// the renderer's own attributes, never from corpus content (whose `"` is emitted as `&quot;`).
    public func rooted(_ html: String) -> String {
        guard !basePath.isEmpty else { return html }
        var out = html
        for attribute in ["href", "src", "action"] {
            out = out.replacing("\(attribute)=\"/", with: "\(attribute)=\"\(basePath)/")
        }
        return out.replacing("data-base=\"\"", with: "data-base=\"\(basePath)\"")
    }

    /// The site-relative path for an incoming request path, or `nil` when it is outside ``basePath``.
    public func sitePath(forRequestPath path: String) -> String? {
        guard !basePath.isEmpty else { return path }
        if path == basePath { return "/" }
        guard path.hasPrefix(basePath + "/") else { return nil }
        return String(path.dropFirst(basePath.count))
    }

    private static func path(of url: String) -> String {
        guard let scheme = url.range(of: "://") else { return "" }
        let afterScheme = url[scheme.upperBound...]
        guard let slash = afterScheme.firstIndex(of: "/") else { return "" }
        return String(afterScheme[slash...])
    }
}
