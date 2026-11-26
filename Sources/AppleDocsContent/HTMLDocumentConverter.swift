import AemiHTML
public import AppleDocsCore

/// Converts Apple HTML documentation pages (WWDC transcripts, App Store Review Guidelines,
/// Apple Archive guides) into normalized ``DocumentRecord`` + ``DocumentSectionRecord`` values
/// using `g-cqd/AemiHTML`'s WHATWG HTML5 arena parser and hidden-content-stripping `HTMLExtractor`.
public enum HTMLDocumentConverter: Sendable {
    /// Result of converting an HTML page into a normalized corpus document and ordered sections.
    public struct ConvertedPage: Hashable, Sendable {
        public let document: DocumentRecord
        public let sections: [DocumentSectionRecord]
    }

    /// Parses raw UTF-8 `html` bytes and builds a ``DocumentRecord`` + section list under `key`.
    public static func convert(
        html: [UInt8],
        key: DocumentKey,
        sourceType: SourceKind,
        fallbackTitle: String,
        url: String? = nil,
        fallsBackToTextDensity: Bool = true
    ) -> ConvertedPage {
        var options = HTMLExtractOptions()
        options.format = .markdown
        options.splitsSections = true
        options.dropsHiddenContent = true
        options.fallsBackToTextDensity = fallsBackToTextDensity

        let extracted = HTMLExtractor.extract(html, options: options)
        let title = (extracted.title?.isEmpty == false) ? (extracted.title ?? fallbackTitle) : fallbackTitle
        let headings = extracted.sections
            .compactMap(\.heading)
            .filter { !$0.isEmpty }
            .joined(separator: "\n")

        let sections = extracted.sections.enumerated()
            .map { index, section in
                DocumentSectionRecord(
                    sectionKind: index == 0 && section.heading == nil ? "overview" : "discussion",
                    heading: section.heading,
                    contentText: section.content,
                    sortOrder: index
                )
            }
        let document = DocumentRecord(
            key: key,
            sourceType: sourceType,
            title: title,
            framework: key.rootSlug,
            url: url,
            abstractText: extracted.description,
            headings: headings.isEmpty ? nil : headings,
            urlDepth: max(0, key.rawValue.split(separator: "/").count - 1)
        )
        return ConvertedPage(document: document, sections: sections)
    }
}
