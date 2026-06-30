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
            let partialKey = segments[0...i].joined(separator: "/")

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
}
