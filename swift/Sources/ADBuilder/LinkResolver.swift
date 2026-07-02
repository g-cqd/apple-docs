// Global link resolver — maps every known external URL pattern to its corpus
// storage key, and packages the rules into the `linkResolver` callback shape the
// Markdown→HTML fallback consumes (and the `classify` form the link audit uses).
//
// Native port of `src/lib/link-resolver.js`. URL→key rules live in one place so
// adding a source is one entry, not a per-adapter edit.
//
// Parity note: the JS uses WHATWG `new URL()`; this uses Foundation
// `URLComponents`. For the apple-docs corpus (standard https URLs, ASCII paths)
// the two agree; `host` is lowercased here to match WHATWG, and `percentEncodedPath`
// is used so the rule patterns see the same (encoded) pathname JS does.

import Foundation

public struct LinkResolver: Sendable {
    let knownKeys: Set<String>?
    let swiftOrgPaths: Set<String>?
    let docsBase: String
    let base: URL?

    /// - Parameters:
    ///   - knownKeys: corpus keys that exist; when supplied every pattern match is
    ///     verified before internalization (else strict pattern rules are trusted).
    ///   - swiftOrgPaths: curated swift.org paths to internalize to `/docs/swift-org/<path>/`.
    ///   - sourceURL: absolute URL of the page being parsed, to resolve relative links.
    ///   - docsBase: internal route prefix (default `/docs`).
    public init(
        knownKeys: Set<String>? = nil, swiftOrgPaths: Set<String>? = nil,
        sourceURL: String? = nil, docsBase: String = "/docs"
    ) {
        self.knownKeys = knownKeys
        self.swiftOrgPaths = swiftOrgPaths
        self.docsBase = docsBase
        self.base = sourceURL.flatMap { URL(string: $0) }
    }

    // MARK: - The resolver callback (htmlToMarkdown linkResolver opt)

    /// Returns the rewritten in-corpus `/docs/<key>/` href, the absolute external
    /// URL, or the original href unchanged. Port of `createLinkResolver`'s callback.
    public func resolve(_ rawHref: String) -> String {
        if rawHref.isEmpty { return rawHref }
        // Bail on schemes we never rewrite.
        let lower = rawHref.lowercased()
        if lower.hasPrefix("mailto:") || lower.hasPrefix("tel:") || lower.hasPrefix("javascript:")
            || lower.hasPrefix("data:") || rawHref.hasPrefix("#")
        {
            return rawHref
        }

        guard let abs = Self.absolute(rawHref, relativeTo: base) else { return rawHref }

        // 1. Already an internal /docs/<key>/ route — leave alone.
        if Self.sameOrigin(abs, base) && abs.percentEncodedPath.hasPrefix("\(docsBase)/") {
            return rawHref
        }

        // 2. Internalize against the structured-pattern rules (verify with knownKeys).
        if let candidate = Self.mapURLToKey(abs),
            knownKeys == nil || knownKeys!.contains(candidate)
        {
            return "\(docsBase)/\(candidate)/\(Self.fragment(abs))"
        }

        // 3. swift.org generic-path opt-in: only when the path is curated.
        if let paths = swiftOrgPaths, Self.isSwiftOrg(abs.host) {
            let path = Self.trimSlashes(abs.percentEncodedPath)
            for variant in [path, "\(path).html"] where paths.contains(variant) {
                return "\(docsBase)/swift-org/\(variant)/\(Self.fragment(abs))"
            }
        }

        // 4. Otherwise the absolute URL (at least the link works as external content).
        return Self.whatwgString(abs) ?? rawHref
    }

    /// WHATWG `URL.toString()` serialization detail Foundation omits: a URL with
    /// a host and an EMPTY path prints with `/` (`https://example.com` →
    /// `https://example.com/`). The JS resolver returns `url.toString()`, so the
    /// external-fallback bytes must match.
    static func whatwgString(_ comps: URLComponents) -> String? {
        var copy = comps
        if copy.percentEncodedPath.isEmpty && copy.host != nil {
            copy.percentEncodedPath = "/"
        }
        return copy.string
    }

    // MARK: - Pure URL→key mapping

    /// Try every URL→key rule in order; first non-null match wins. Pure, no I/O.
    public static func mapUrlToKey(_ url: String) -> String? {
        guard !url.isEmpty, let comps = absolute(url, relativeTo: nil) else { return nil }
        return mapURLToKey(comps)
    }

    static func mapURLToKey(_ comps: URLComponents) -> String? {
        let host = comps.host?.lowercased() ?? ""
        let path = comps.percentEncodedPath

        // swift.org redirect aliases win over the generic rules.
        if isSwiftOrg(host) {
            let p = trimSlashes(path)
            if let redirect = swiftOrgRedirects[p] { return redirect }
        }

        // developer.apple.com/documentation/<rest> → <rest> (lowercased)
        if host == "developer.apple.com", path.hasPrefix("/documentation/") {
            let rest = trimTrailingSlashes(String(path.dropFirst("/documentation/".count)))
            return rest.isEmpty ? nil : rest.lowercased()
        }
        // developer.apple.com/design/<rest> → design/<rest> (lowercased)
        if host == "developer.apple.com", path.hasPrefix("/design/") {
            let rest = trimTrailingSlashes(dropLeadingSlash(path))
            return rest.isEmpty ? nil : rest.lowercased()
        }
        // developer.apple.com/library/archive/<rest> → apple-archive/<rest> (original case)
        if host == "developer.apple.com", path.hasPrefix("/library/archive/") {
            let rest = trimTrailingSlashes(String(path.dropFirst("/library/archive/".count)))
            if rest.isEmpty { return nil }
            if let m = matchArchiveHtml(rest) {
                let parent = m.dir.split(separator: "/").last.map(String.init) ?? ""
                if m.base.lowercased() == "index" || m.base.lowercased() == parent.lowercased() {
                    return "apple-archive/\(m.dir)"
                }
                return "apple-archive/\(m.dir)/\(m.base).\(m.ext.lowercased())"
            }
            return "apple-archive/\(rest)"
        }
        // developer.apple.com/videos/play/wwdcYYYY/ID → wwdc/wwdcYYYY-ID
        if host == "developer.apple.com", let wwdc = matchWwdc(path) {
            return "wwdc/\(wwdc.year)-\(wwdc.id)"
        }
        // docs.swift.org/swift-book/<rest> → swift-book/<rest>
        if host == "docs.swift.org", path.hasPrefix("/swift-book/") {
            let rest = trimTrailingSlashes(String(path.dropFirst("/swift-book/".count)))
            return rest.isEmpty ? "swift-book" : "swift-book/\(rest)"
        }
        // docs.swift.org/compiler/<rest> → swift-compiler/<rest>
        if host == "docs.swift.org", path.hasPrefix("/compiler/") {
            let rest = trimTrailingSlashes(String(path.dropFirst("/compiler/".count)))
            return rest.isEmpty ? "swift-compiler" : "swift-compiler/\(rest)"
        }
        // docs.swift.org/swiftpm/<rest> → swift-package-manager/<rest>
        if host == "docs.swift.org", path.hasPrefix("/swiftpm/") {
            let rest = trimTrailingSlashes(String(path.dropFirst("/swiftpm/".count)))
            return rest.isEmpty ? "swift-package-manager" : "swift-package-manager/\(rest)"
        }
        // swift.org/migration/<rest> → swift-migration-guide/<rest>
        if isSwiftOrg(host), path.hasPrefix("/migration/") {
            let rest = trimTrailingSlashes(String(path.dropFirst("/migration/".count)))
            return rest.isEmpty ? "swift-migration-guide" : "swift-migration-guide/\(rest)"
        }
        // swift.org/swift-evolution/proposals/NNNN-… → swift-evolution/NNNN-…
        if isSwiftOrg(host), path.hasPrefix("/swift-evolution/proposals/"),
            startsWithProposalNumber(String(path.dropFirst("/swift-evolution/proposals/".count)))
        {
            return matchProposalId(path).map { "swift-evolution/\($0)" }
        }
        // github.com/(apple|swiftlang)/swift-evolution/(blob|tree)/… → swift-evolution/NNNN-…
        if host == "github.com", isGithubSwiftEvolution(path) {
            return matchProposalId(path).map { "swift-evolution/\($0)" }
        }
        return nil
    }

    // MARK: - Link classification (for the build's link audit)

    public enum LinkClass: Equatable, Sendable {
        case fragment
        case internalOk(key: String)
        case internalBroken(key: String)
        case externalResolvable(key: String, normalized: String)
        case external(normalized: String)
        case relativeBroken(normalized: String?)
    }

    /// Classify a single URL for audit purposes. Port of `classifyLink`.
    public static func classify(_ url: String, knownKeys: Set<String>, docsBase: String = "/docs")
        -> LinkClass
    {
        if url.isEmpty { return .relativeBroken(normalized: nil) }
        if url.hasPrefix("#") { return .fragment }

        let lower = url.lowercased()
        if lower.hasPrefix("mailto:") || lower.hasPrefix("tel:") || lower.hasPrefix("javascript:")
            || lower.hasPrefix("data:")
        {
            return .external(normalized: url)
        }

        // Internal /docs/<key>/ — verify the key resolves.
        if url.hasPrefix("\(docsBase)/") {
            let key = docsKey(url, docsBase: docsBase)
            if let key, knownKeys.contains(key) { return .internalOk(key: key) }
            return .internalBroken(key: key ?? url)
        }

        // Any other host-relative path — flag as broken.
        if url.hasPrefix("/") { return .relativeBroken(normalized: url) }

        // Absolute URL: try to internalize, else external.
        guard let comps = absolute(url, relativeTo: nil) else {
            return .relativeBroken(normalized: url)
        }
        if let candidate = mapURLToKey(comps), knownKeys.contains(candidate) {
            return .externalResolvable(key: candidate, normalized: url)
        }
        return .external(normalized: url)
    }

    // MARK: - swift.org redirects + host check

    static let swiftOrgRedirects: [String: String] = [
        "documentation/concurrency": "swift-migration-guide/documentation/migrationguide",
        "documentation/package-manager": "swift-package-manager/documentation/packagemanagerdocs",
        "documentation/tspl": "swift-book/The-Swift-Programming-Language",
    ]

    static func isSwiftOrg(_ host: String?) -> Bool {
        host == "swift.org" || host == "www.swift.org"
    }

    // MARK: - URL helpers (WHATWG-equivalent accessors over URLComponents)

    /// Resolve `rawHref` (optionally against `base`) into an ABSOLUTE URL's
    /// components, or nil when it is not absolute (no scheme/host) — mirroring
    /// `new URL()` throwing on a relative ref with no base.
    static func absolute(_ rawHref: String, relativeTo base: URL?) -> URLComponents? {
        let resolved: URL?
        if let base { resolved = URL(string: rawHref, relativeTo: base)?.absoluteURL } else {
            resolved = URL(string: rawHref)
        }
        guard let resolved,
            let comps = URLComponents(url: resolved, resolvingAgainstBaseURL: true),
            comps.scheme != nil, comps.host != nil
        else { return nil }
        return comps
    }

    /// `#fragment` (encoded, with leading `#`) or `""` — JS `u.hash`.
    static func fragment(_ comps: URLComponents) -> String {
        comps.percentEncodedFragment.map { "#\($0)" } ?? ""
    }

    static func sameOrigin(_ a: URLComponents, _ base: URL?) -> Bool {
        guard let base, let b = URLComponents(url: base, resolvingAgainstBaseURL: true) else {
            return true  // no base → JS `base?.origin ?? abs.origin` makes this always true
        }
        return a.scheme?.lowercased() == b.scheme?.lowercased()
            && a.host?.lowercased() == b.host?.lowercased() && a.port == b.port
    }

    // MARK: - String trimming (regex-free)

    static func trimTrailingSlashes(_ s: String) -> String {
        var end = s.endIndex
        while end > s.startIndex, s[s.index(before: end)] == "/" { end = s.index(before: end) }
        return String(s[s.startIndex ..< end])
    }

    static func dropLeadingSlash(_ s: String) -> String {
        s.hasPrefix("/") ? String(s.dropFirst()) : s
    }

    static func trimSlashes(_ s: String) -> String {
        var start = s.startIndex
        while start < s.endIndex, s[start] == "/" { start = s.index(after: start) }
        return trimTrailingSlashes(String(s[start...]))
    }

    // MARK: - Pattern matchers (regex-free, parity with the JS regexes)

    /// `/^\/videos\/play\/(wwdc\d{4})\/(\d+)\/?$/`
    static func matchWwdc(_ path: String) -> (year: String, id: String)? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count == 4, parts[0] == "videos", parts[1] == "play" else { return nil }
        let year = parts[2], id = parts[3]
        guard year.hasPrefix("wwdc"), year.count == 8,
            year.dropFirst(4).allSatisfy(\.isNumber),
            !id.isEmpty, id.allSatisfy(\.isNumber)
        else { return nil }
        return (String(year), String(id))
    }

    /// The `\d{4}-` prefix test for `/swift-evolution/proposals/<rest>`.
    static func startsWithProposalNumber(_ rest: String) -> Bool {
        let four = rest.prefix(4)
        return four.count == 4 && four.allSatisfy(\.isNumber) && rest.dropFirst(4).first == "-"
    }

    /// `\/proposals\/(\d{4}-[^/]+?)(?:\.md|\.html)?\/?$` → the `NNNN-name` id.
    static func matchProposalId(_ path: String) -> String? {
        guard let r = path.range(of: "/proposals/") else { return nil }
        var rest = trimTrailingSlashes(String(path[r.upperBound...]))
        if rest.hasSuffix(".md") { rest = String(rest.dropLast(3)) } else if rest.hasSuffix(".html")
        {
            rest = String(rest.dropLast(5))
        }
        guard !rest.contains("/"), startsWithProposalNumber(rest) else { return nil }
        return rest
    }

    /// `/^\/(?:apple|swiftlang)\/swift-evolution\/(?:blob|tree)\//`
    static func isGithubSwiftEvolution(_ path: String) -> Bool {
        for owner in ["apple", "swiftlang"] {
            for kind in ["blob", "tree"] where path.hasPrefix("/\(owner)/swift-evolution/\(kind)/") {
                return true
            }
        }
        return false
    }

    /// `/^(.*)\/([^/]+)\.(html|htm)$/i` → (dir, base, ext) where ext is original case.
    static func matchArchiveHtml(_ s: String) -> (dir: String, base: String, ext: String)? {
        guard let dot = s.range(of: ".", options: .backwards) else { return nil }
        let ext = String(s[dot.upperBound...])
        let lowerExt = ext.lowercased()
        guard lowerExt == "html" || lowerExt == "htm" else { return nil }
        let beforeExt = String(s[..<dot.lowerBound])
        guard let slash = beforeExt.range(of: "/", options: .backwards) else { return nil }
        let base = String(beforeExt[slash.upperBound...])
        guard !base.isEmpty else { return nil }
        return (String(beforeExt[..<slash.lowerBound]), base, ext)
    }

    /// The corpus key from a `<docsBase>/<key>/?(#|?…)` URL — `^([^?#]+?)\/?(?:[?#].*)?$`
    /// then percent-decoded (JS `decodeURIComponent`).
    static func docsKey(_ url: String, docsBase: String) -> String? {
        let afterBase = String(url.dropFirst(docsBase.count + 1))
        // Cut at the first ? or #.
        let body = afterBase.prefix { $0 != "?" && $0 != "#" }
        let key = trimTrailingSlashes(String(body))
        guard !key.isEmpty else { return nil }
        return key.removingPercentEncoding ?? key
    }
}
