// Pure HTML helpers used across the render cluster — native port of
// `src/content/render-html/helpers.js`. Regex-free for deterministic parity.

public enum RenderHelpers {
    /// HTML-escape the five entities. A single pass is byte-identical to the JS
    /// sequential `replaceAll` chain (none of the replacements reintroduce a
    /// trigger char that a later pass would touch). Port of `escapeHtml`.
    static func escapeHtml(_ value: String) -> String {
        var out = ""
        out.reserveCapacity(value.count)
        for ch in value {
            switch ch {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#39;"
            default: out.append(ch)
            }
        }
        return out
    }

    /// URL-safe slug: lowercase → trim → `\s+`→`-` → drop non-`[\w-]` → collapse
    /// `-` → strip end dashes. Port of `slugify`. Public so the web build's TOC
    /// ids match the section ids the renderer emits.
    public static func slugify(_ text: String) -> String {
        var s = Substring(text.lowercased())
        while let f = s.first, f.isWhitespace { s = s.dropFirst() }
        while let l = s.last, l.isWhitespace { s = s.dropLast() }

        // \s+ → '-'
        var dashed = ""
        var inWs = false
        for ch in s {
            if ch.isWhitespace {
                if !inWs { dashed.append("-"); inWs = true }
            } else {
                dashed.append(ch)
                inWs = false
            }
        }
        // drop [^\w-] (\w == ASCII letters/digits/underscore), then collapse '-'
        var out = ""
        var inDash = false
        for ch in dashed {
            if ch == "-" {
                if !inDash { out.append("-"); inDash = true }
            } else if isWordChar(ch) {
                out.append(ch)
                inDash = false
            }
        }
        while out.hasPrefix("-") { out.removeFirst() }
        while out.hasSuffix("-") { out.removeLast() }
        return out
    }

    /// Allowlist for href attributes: `#…`, root-relative `/…`, or `http(s)://`
    /// (protocol-relative `//…` rejected). Port of `isSafeHref`.
    static func isSafeHref(_ href: String) -> Bool {
        if href.isEmpty { return false }
        if href.hasPrefix("#") { return true }
        if href.hasPrefix("//") { return false }
        if href.hasPrefix("/") { return true }
        let lower = href.lowercased()
        return lower.hasPrefix("http://") || lower.hasPrefix("https://")
    }

    /// Human name from a key's last segment: `swiftui/animation/linear` → `Linear`.
    /// Port of `readableNameFromKey`.
    static func readableNameFromKey(_ key: String) -> String {
        if key.isEmpty { return "" }
        let last = key.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? ""
        return last.split(separator: "-", omittingEmptySubsequences: false)
            .map { capitalizeFirst(String($0)) }
            .joined(separator: " ")
    }

    /// A resolved external reference target.
    struct ReferenceURL: Equatable, Sendable {
        let href: String
        let title: String
    }

    /// Resolve a reference identifier to an external URL when corpus-key mapping
    /// fails: bare `http(s)://`, `doc://…/videos/play/<event>/<id>`, or other
    /// `doc://` paths. Port of `resolveReferenceUrl`.
    static func resolveReferenceUrl(_ identifier: String) -> ReferenceURL? {
        if identifier.isEmpty { return nil }

        // Direct http(s):// URL (case-sensitive, like the JS `/^https?:\/\//`).
        if identifier.hasPrefix("http://") || identifier.hasPrefix("https://") {
            var url = Substring(identifier)
            while url.hasSuffix("/") { url = url.dropLast() }
            let parts = url.split(separator: "/", omittingEmptySubsequences: false)
            let lastSeg = parts.last.map(String.init) ?? ""
            let seg = lastSeg.isEmpty ? String(url) : lastSeg
            // [-_] → ' ', strip trailing .ext, Title-Case each space-token.
            let spaced = String(seg.map { ($0 == "-" || $0 == "_") ? " " : $0 })
            let title = stripTrailingExt(spaced)
                .split(separator: " ", omittingEmptySubsequences: false)
                .map { capitalizeFirst(String($0)) }
                .joined(separator: " ")
            return ReferenceURL(href: identifier, title: title.isEmpty ? identifier : title)
        }

        // doc://<authority>/<rest>
        guard identifier.hasPrefix("doc://") else { return nil }
        let afterScheme = identifier.dropFirst("doc://".count)
        guard let authSlash = afterScheme.firstIndex(of: "/") else { return nil }
        guard authSlash != afterScheme.startIndex else { return nil }  // [^/]+ needs ≥1
        let rest = afterScheme[afterScheme.index(after: authSlash)...]
        guard !rest.isEmpty else { return nil }  // (.+) needs ≥1

        // …/videos/play/<event>/<id>
        if rest.hasPrefix("videos/play/") {
            let afterPlay = rest.dropFirst("videos/play/".count)
            if let evSlash = afterPlay.firstIndex(of: "/"), evSlash != afterPlay.startIndex {
                let event = afterPlay[..<evSlash]
                let afterEvent = afterPlay[afterPlay.index(after: evSlash)...]
                let digits = afterEvent.prefix { $0 >= "0" && $0 <= "9" }
                if event.allSatisfy(isWordChar), !digits.isEmpty {
                    return ReferenceURL(
                        href: "https://developer.apple.com/videos/play/\(event)/\(digits)/",
                        title: "\(event.uppercased()) Session \(digits)")
                }
            }
        }

        // doc:// with a non-documentation path.
        return ReferenceURL(
            href: "https://developer.apple.com/\(rest)", title: readableNameFromKey(String(rest)))
    }

    // MARK: - private

    /// `word.charAt(0).toUpperCase() + word.slice(1)` (empty → empty).
    static func capitalizeFirst(_ w: String) -> String {
        guard let first = w.first else { return "" }
        return String(first).uppercased() + w.dropFirst()
    }

    /// Remove a trailing `.<ext>` where ext is `\w+` (JS `/\.\w+$/`).
    private static func stripTrailingExt(_ s: String) -> String {
        guard let dot = s.lastIndex(of: ".") else { return s }
        let after = s[s.index(after: dot)...]
        guard !after.isEmpty, after.allSatisfy(isWordChar) else { return s }
        return String(s[..<dot])
    }

    /// JS `\w` — ASCII letter, digit, or underscore.
    private static func isWordChar(_ ch: Character) -> Bool {
        (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch == "_"
    }
}
