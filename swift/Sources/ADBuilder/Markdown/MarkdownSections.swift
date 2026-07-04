// MarkdownSections — parse a Markdown SOURCE file into the normalized section model
// (the role of src/content/parse-markdown.js `parseMarkdownToSections`, used by the
// Swift Evolution + Swift Book adapters). Built on swiftlang/swift-markdown
// (CommonMark / cmark-gfm) instead of the retiring JS regex extractor:
//
//   • title       ← the first level-1 ATX heading
//   • abstract    ← the first paragraph before the first level-2 heading
//   • headings    ← the level-2 heading texts, space-joined (for FTS)
//   • sections    ← `abstract` (the first paragraph) + one `discussion` per `##` block
//
// STRUCTURE-LEVEL parity (not byte-exact): a real parser ignores `## ` inside a code
// fence (the JS regex matched it) and skips a metadata bullet list when locating the
// abstract (the JS regex returned it). YAML frontmatter is stripped before parsing
// (swift-markdown would otherwise read the `---` fence as a thematic break).
import Foundation
import Markdown

public enum MarkdownSections {
    /// The `createDocumentTemplate` opts (source-type/kind/framework/url/… passthrough).
    public struct Options: Sendable {
        public var sourceType: String?
        public var kind: String?
        public var framework: String?
        public var url: String?
        public var language: String?
        public var sourceMetadata: String?
        public init(
            sourceType: String? = nil, kind: String? = nil, framework: String? = nil,
            url: String? = nil, language: String? = nil, sourceMetadata: String? = nil
        ) {
            self.sourceType = sourceType
            self.kind = kind
            self.framework = framework
            self.url = url
            self.language = language
            self.sourceMetadata = sourceMetadata
        }
    }

    /// Parse `markdown` into a ``NormalizedPage`` keyed by `key`.
    public static func parse(_ markdown: String, key: String, options: Options = Options()) -> NormalizedPage {
        let stripped = stripFrontmatter(markdown)
        let document = Document(parsing: stripped.body)

        var title: String?
        var headingTexts: [String] = []
        var leadBlocks: [any Markup] = []  // top-level blocks before the first `##`
        var sections: [(heading: String, blocks: [any Markup])] = []

        for child in document.children {
            if let heading = child as? Heading {
                if heading.level == 1 {
                    if title == nil { title = trimmed(heading.plainText) }
                    continue
                }
                if heading.level == 2 {
                    let text = trimmed(heading.plainText)
                    headingTexts.append(text)
                    sections.append((heading: text, blocks: []))
                    continue
                }
            }
            if sections.isEmpty {
                leadBlocks.append(child)
            } else {
                sections[sections.count - 1].blocks.append(child)
            }
        }

        if title == nil, let frontmatterTitle = stripped.title { title = frontmatterTitle }

        // Abstract: the first paragraph before the first `##`.
        let abstractText = leadBlocks.lazy.compactMap { $0 as? Paragraph }.first.map { trimmed($0.format()) }
            .flatMap { $0.isEmpty ? nil : $0 }
        let headings = headingTexts.isEmpty ? nil : headingTexts.joined(separator: " ")

        let documentModel = documentTemplate(
            key: key, title: title, abstractText: abstractText, headings: headings, options: options)

        var normalizedSections: [NormalizedSection] = []
        var order = 0
        if let abstractText {
            normalizedSections.append(
                NormalizedSection(sectionKind: "abstract", contentText: abstractText, sortOrder: order))
            order += 1
        }
        for section in sections {
            let content = section.blocks.map { $0.format() }.joined(separator: "\n\n")
            let trimmedContent = trimmed(content)
            normalizedSections.append(
                NormalizedSection(
                    sectionKind: "discussion", heading: section.heading,
                    contentText: trimmedContent.isEmpty ? nil : trimmedContent, sortOrder: order))
            order += 1
        }

        return NormalizedPage(document: documentModel, sections: normalizedSections, relationships: [])
    }

    // MARK: - document template (mirrors content/document-template.js)

    static func documentTemplate(
        key: String, title: String?, abstractText: String?, headings: String?, options: Options
    ) -> NormalizedDocument {
        NormalizedDocument(
            sourceType: options.sourceType, key: key, title: title, kind: options.kind ?? "article",
            role: "article", framework: options.framework, url: options.url, language: options.language,
            abstractText: abstractText, isDeprecated: false, isBeta: false, isReleaseNotes: false,
            urlDepth: key.isEmpty ? 0 : key.split(separator: "/", omittingEmptySubsequences: false).count - 1,
            headings: headings, sourceMetadata: options.sourceMetadata)
    }

    // MARK: - frontmatter (body strip; mirrors parse-markdown.js extractFrontmatter)

    /// Strip a leading `---\n…\n---` YAML frontmatter block, returning the body and a
    /// best-effort `title:` from the frontmatter (the title fallback). Faithful to the
    /// JS delimiter handling; the YAML body is scanned only for a top-level `title:`.
    static func stripFrontmatter(_ markdown: String) -> (title: String?, body: String) {
        guard markdown.hasPrefix("---") else { return (nil, markdown) }
        let afterOpen = String(markdown.dropFirst(3))
        guard let firstChar = afterOpen.first, firstChar == "\n" || firstChar == "\r" else {
            return (nil, markdown)
        }
        guard let closingRange = afterOpen.range(of: "\n---") else { return (nil, markdown) }
        let yamlStart = afterOpen.index(afterOpen.startIndex, offsetBy: firstChar == "\n" ? 1 : 2)
        let yamlBlock = String(afterOpen[yamlStart ..< closingRange.lowerBound])
        var afterClose = String(afterOpen[closingRange.upperBound...])  // after "\n---"
        // The JS skips to the end of the closing `---` line + a following newline.
        if let newline = afterClose.firstIndex(of: "\n") {
            afterClose = String(afterClose[afterClose.index(after: newline)...])
        } else {
            afterClose = ""
        }
        return (frontmatterTitle(yamlBlock), afterClose)
    }

    /// A best-effort `title: <value>` lookup in a YAML block (unquoted).
    private static func frontmatterTitle(_ yaml: String) -> String? {
        for line in yaml.split(separator: "\n", omittingEmptySubsequences: false) {
            let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard parts.count == 2, trimmed(String(parts[0])) == "title" else { continue }
            let value = trimmed(String(parts[1]))
            if value.isEmpty { return nil }
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")),
                value.count >= 2
            {
                return String(value.dropFirst().dropLast())
            }
            return value
        }
        return nil
    }

    private static func trimmed(_ text: String) -> String {
        String(text.drop(while: \.isWhitespace).reversed().drop(while: \.isWhitespace).reversed())
    }
}
