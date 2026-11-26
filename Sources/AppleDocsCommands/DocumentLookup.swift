public import AemiJSONCore
import AppleDocsContent
public import AppleDocsCore
public import AppleDocsStorage
import OrderedCollections

/// Port of Bun's `commands/lookup.js`: resolves a page by path (retrying the canonical identifier form) or by
/// symbol title, renders it with Bun's Markdown renderer, and returns Bun's rich lookup envelope
/// (`{found, metadata, content, sections, note}`) as an ordered ``JSONValue`` so MCP pagination and projection
/// see exactly the object Bun would build.
public enum DocumentLookup {
    /// What to look up.
    public struct Request: Sendable {
        public var path: String?
        public var symbol: String?
        public var framework: String?
        public var section: String?
        public var includeSections: Bool

        public init(
            path: String? = nil,
            symbol: String? = nil,
            framework: String? = nil,
            section: String? = nil,
            includeSections: Bool = false
        ) {
            self.path = path
            self.symbol = symbol
            self.framework = framework
            self.section = section
            self.includeSections = includeSections
        }
    }

    static let renderedNote = "Rendered on-demand from normalized content."
    static let noContentNote = "No content available. Run apple-docs sync first."

    /// The lookup envelope, or `{found: false, path}` when nothing matches.
    public static func lookup(_ request: Request, on store: CorpusStore) throws(SQLiteError) -> JSONValue {
        guard let page = try findPage(request, on: store) else {
            return .object(["found": .bool(false), "path": DocCValue.optional(request.path ?? request.symbol)])
        }
        let sections = try store.sections(forKey: page.document.key)
        let metadata = try metadataObject(page, on: store)
        let content = sections.isEmpty ? nil : BunMarkdownRenderer.render(page.header, sections: sections)
        let includeSections = request.includeSections || request.section != nil
        if let query = request.section, !sections.isEmpty {
            return sectionEnvelope(query: query, sections: sections, metadata: metadata)
        }
        var envelope: OrderedDictionary<String, JSONValue> = [
            "found": .bool(true),
            "metadata": metadata,
            "content": DocCValue.optional(content),
            "sections": .array(includeSections ? sections.map(coercedSection) : [])
        ]
        envelope["note"] = .string(content == nil ? noContentNote : renderedNote)
        return .object(envelope)
    }

    /// `coerceSection`: `{sectionKind, heading, contentText, sortOrder}`.
    public static func coercedSection(_ section: DocumentSectionRecord) -> JSONValue {
        .object([
            "sectionKind": .string(section.sectionKind),
            "heading": DocCValue.optional(section.heading),
            "contentText": .string(section.contentText),
            "sortOrder": .int(Int64(section.sortOrder))
        ])
    }

    private static func sectionEnvelope(
        query: String,
        sections: [DocumentSectionRecord],
        metadata: JSONValue
    ) -> JSONValue {
        let match =
            sections.first { section in
                section.heading == query || section.heading?.hasSuffix(query) == true || section.sectionKind == query
            } ?? sections.first { $0.contentText.contains(query) }
        if let match {
            return .object([
                "found": .bool(true), "metadata": metadata, "content": .string(match.contentText),
                "sections": .array([coercedSection(match)])
            ])
        }
        let available = sections.map { $0.heading ?? $0.sectionKind }.filter { !$0.isEmpty }.joined(separator: ", ")
        return .object([
            "found": .bool(true), "metadata": metadata, "content": .null,
            "sections": .array(sections.map(coercedSection)),
            "note": .string("Section not found: \(query). Available sections: \(available)")
        ])
    }
}
