import Foundation

extension PublicDocumentDetail {
    /// Finds the first section whose heading matches `heading` (case-insensitive exact match first,
    /// then substring containment).
    public func section(named heading: String) -> Section? {
        let needle = heading.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return nil }
        if let exact = sections.first(where: { $0.heading?.lowercased() == needle }) {
            return exact
        }
        return sections.first(where: { $0.heading?.lowercased().contains(needle) == true })
    }

    /// Renders either the whole document or a single heading-matched section into Markdown.
    /// Returns `nil` when `sectionHeading` is provided but no section matches.
    public func renderMarkdown(sectionHeading: String?) -> String? {
        guard let sectionHeading, !sectionHeading.isEmpty else {
            return renderMarkdown()
        }
        guard let matched = section(named: sectionHeading) else {
            return nil
        }
        var lines: [String] = ["# \(document.title)"]
        if let heading = matched.heading, !heading.isEmpty {
            lines.append("")
            lines.append("## \(heading)")
        }
        lines.append("")
        lines.append(matched.content)
        return lines.joined(separator: "\n")
    }

    /// Locates up to `maxMatches` excerpt windows around occurrences of `query` across the rendered
    /// document, clamping `context` to `20...2_000` and `maxMatches` to `1...50`.
    public func matchExcerpts(
        query: String,
        context: Int = 140,
        maxMatches: Int = 5,
        caseSensitive: Bool = false
    ) -> [PublicMatchExcerpt] {
        guard !query.isEmpty else { return [] }
        let clampedContext = max(20, min(context, 2_000))
        let clampedMax = max(1, min(maxMatches, 50))

        var chunks: [(heading: String?, text: String)] = []
        if let abstract = document.abstract, !abstract.isEmpty {
            chunks.append((nil, abstract))
        }
        if let declaration = document.declaration, !declaration.isEmpty {
            chunks.append(("Declaration", declaration))
        }
        for section in sections {
            chunks.append((section.heading, section.content))
        }

        let needle = caseSensitive ? query : query.lowercased()
        let needleCount = needle.count
        var results: [PublicMatchExcerpt] = []
        results.reserveCapacity(clampedMax)

        for chunk in chunks where results.count < clampedMax {
            let haystack = caseSensitive ? chunk.text : chunk.text.lowercased()
            let chars = Array(chunk.text)
            let hayChars = Array(haystack)
            let needleChars = Array(needle)
            guard needleCount > 0, hayChars.count >= needleCount else { continue }

            var pos = 0
            while pos <= hayChars.count - needleCount, results.count < clampedMax {
                if hayChars[pos ..< (pos + needleCount)].elementsEqual(needleChars) {
                    let start = max(0, pos - clampedContext)
                    let end = min(chars.count, pos + needleCount + clampedContext)
                    let slice = String(chars[start ..< end]).trimmingCharacters(in: .whitespacesAndNewlines)
                    let prefix = start > 0 ? "..." : ""
                    let suffix = end < chars.count ? "..." : ""
                    results.append(
                        PublicMatchExcerpt(
                            sectionHeading: chunk.heading,
                            offset: pos,
                            excerpt: "\(prefix)\(slice)\(suffix)"
                        )
                    )
                    pos += needleCount
                } else {
                    pos += 1
                }
            }
        }
        return results
    }
}
