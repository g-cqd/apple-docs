// Breadcrumb nav (and, later, the matching BreadcrumbList JSON-LD) — port of
// `src/web/templates/breadcrumbs.js`. Intermediate path segments with no
// resolving page render as plain text (no dangling 404 link).

import ADBase

enum Breadcrumbs {
    private static func esc(_ s: String) -> String { WebHtml.escape(s) }

    /// buildBreadcrumbs(key, opts).
    static func buildBreadcrumbs(
        _ key: String, title: String? = nil, framework: String? = nil,
        ancestorTitles: [String: String] = [:], knownKeys: Set<String>? = nil
    ) -> String {
        if key.isEmpty { return "" }
        let segments = key.split(separator: "/").map(String.init)  // .filter(Boolean)
        if segments.isEmpty { return "" }

        let lastLabel = title ?? segments[segments.count - 1]
        if segments.count == 1 {
            return "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\"><span>\(esc(lastLabel))</span></nav>"
        }

        var parts: [String] = []
        for i in segments.indices {
            let isLast = i == segments.count - 1
            let partialKey = segments[0 ... i].joined(separator: "/")

            let label: String
            if isLast {
                label = lastLabel
            } else if i == 0, let framework, !framework.isEmpty {
                label = framework
            } else if let ancestor = ancestorTitles[partialKey] {
                label = ancestor
            } else {
                label = segments[i]
            }

            let isFrameworkRoot = i == 0
            if isLast {
                parts.append("<span aria-current=\"page\">\(esc(label))</span>")
            } else if let knownKeys, !isFrameworkRoot, !knownKeys.contains(partialKey) {
                parts.append("<span>\(esc(label))</span>")
            } else {
                let href = "/docs/\(SafePath.safeWebDocKey(partialKey))/"
                parts.append("<a href=\"\(esc(href))\">\(esc(label))</a>")
            }
        }

        let sep = "<span class=\"breadcrumb-sep\" aria-hidden=\"true\"> / </span>"
        return "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\">\(parts.joined(separator: sep))</nav>"
    }

    /// buildBreadcrumbListJsonLd(key, baseUrl, opts) — the schema.org BreadcrumbList
    /// (the terminal segment intentionally has no `item` URL). nil for an empty key.
    static func buildBreadcrumbListJsonLd(
        _ key: String, baseUrl: String, title: String? = nil, framework: String? = nil,
        ancestorTitles: [String: String] = [:]
    ) -> JsonLd? {
        if key.isEmpty { return nil }
        let segments = key.split(separator: "/").map(String.init)
        if segments.isEmpty { return nil }
        let cleanBase = stripTrailingSlashes(baseUrl)
        let lastLabel = title ?? segments[segments.count - 1]

        var items: [JsonLd] = []
        for i in segments.indices {
            let isLast = i == segments.count - 1
            let partialKey = segments[0 ... i].joined(separator: "/")

            let name: String
            if isLast {
                name = lastLabel
            } else if i == 0, let framework, !framework.isEmpty {
                name = framework
            } else if let ancestor = ancestorTitles[partialKey] {
                name = ancestor
            } else {
                name = segments[i]
            }

            var entry: [(String, JsonLd)] = [
                ("@type", .string("ListItem")), ("position", .int(i + 1)), ("name", .string(name))
            ]
            if !isLast {
                entry.append(("item", .string("\(cleanBase)/docs/\(SafePath.safeWebDocKey(partialKey))/")))
            }
            items.append(.object(entry))
        }
        return .object([("@type", .string("BreadcrumbList")), ("itemListElement", .array(items))])
    }

    /// `.replace(/\/+$/, '')`.
    private static func stripTrailingSlashes(_ s: String) -> String {
        var end = s.endIndex
        while end > s.startIndex, s[s.index(before: end)] == "/" { end = s.index(before: end) }
        return String(s[s.startIndex ..< end])
    }
}
