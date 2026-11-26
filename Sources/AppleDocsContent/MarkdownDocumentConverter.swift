import AemiMarkdown
public import AppleDocsCore

/// Converts CommonMark/GFM Markdown documents (Swift Evolution proposals, Swift Book chapters,
/// Swift.org guides, Package docs) with optional YAML/TOML/JSON front-matter into normalized
/// ``ConvertedDocument`` values using `g-cqd/AemiMarkdown`.
public enum MarkdownDocumentConverter: Sendable {
    /// Parses UTF-8 Markdown `bytes` via `AemiMarkdown`, splitting sections at headings (`H2`–`H6`)
    /// and extracting title from YAML front-matter or the first `H1` heading.
    public static func convert(
        markdown bytes: [UInt8],
        key: DocumentKey,
        sourceType: SourceKind,
        fallbackTitle: String,
        url: String? = nil
    ) -> ConvertedDocument {
        let parsed = MarkdownParser.parse(bytes, extensions: [.github, .frontMatter])
        let source = parsed.source

        var title: String?
        var abstractText: String?
        var builder = ConvertedDocument.SectionBuilder()

        for block in parsed.topLevelBlocks {
            let slice = sliceUTF8(source, range: block.sourceRange)
            if block.node.kind == .frontMatter {
                if title == nil {
                    title = extractFrontMatterField(named: "title", from: slice)
                }
                continue
            }
            if block.node.kind == .heading {
                let headingText = stripATXHeadingPrefix(slice)
                if Int(block.node.payload) == 1, title == nil {
                    title = headingText
                    continue
                }
                builder.startSection(heading: headingText)
                continue
            }
            let trimmed = trimASCII(slice)
            guard !trimmed.isEmpty else { continue }
            if abstractText == nil, block.node.kind == .paragraph {
                abstractText = trimmed
            }
            builder.appendBlock(trimmed)
        }

        let sections = builder.finish()
        let resolvedTitle = (title?.isEmpty == false) ? (title ?? fallbackTitle) : fallbackTitle
        let headings = sections.compactMap(\.heading).filter { !$0.isEmpty }.joined(separator: "\n")
        let document = DocumentRecord(
            key: key,
            sourceType: sourceType,
            title: resolvedTitle,
            framework: key.rootSlug,
            url: url,
            abstractText: abstractText,
            headings: headings.isEmpty ? nil : headings,
            urlDepth: max(0, key.rawValue.split(separator: "/").count - 1)
        )
        return ConvertedDocument(document: document, sections: sections)
    }

    private static func sliceUTF8(_ bytes: ContiguousArray<UInt8>, range: Range<Int>) -> String {
        guard range.lowerBound >= 0, range.upperBound <= bytes.count, range.lowerBound < range.upperBound else {
            return ""
        }
        return String(decoding: bytes[range], as: UTF8.self)
    }

    private static func stripATXHeadingPrefix(_ raw: String) -> String {
        var rest = trimASCII(raw)
        while rest.hasPrefix("#") { rest.removeFirst() }
        while rest.hasSuffix("#") { rest.removeLast() }
        return trimASCII(rest)
    }

    private static func extractFrontMatterField(named key: String, from raw: String) -> String? {
        let prefix = "\(key):"
        for line in raw.split(separator: "\n") {
            let trimmed = trimASCII(String(line))
            if trimmed.lowercased().hasPrefix(prefix) {
                var value = trimASCII(String(trimmed.dropFirst(prefix.count)))
                if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")),
                    value.count >= 2
                {
                    value = String(value.dropFirst().dropLast())
                }
                if !value.isEmpty { return value }
            }
        }
        return nil
    }

    private static func trimASCII(_ value: String) -> String {
        var start = value.startIndex
        while start < value.endIndex,
            value[start] == " " || value[start] == "\t" || value[start] == "\r" || value[start] == "\n"
        {
            start = value.index(after: start)
        }
        var end = value.endIndex
        while end > start {
            let prev = value.index(before: end)
            let c = value[prev]
            guard c == " " || c == "\t" || c == "\r" || c == "\n" else { break }
            end = prev
        }
        return String(value[start ..< end])
    }
}
