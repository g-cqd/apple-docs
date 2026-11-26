public import AppleDocsCore

/// Public document detail payload serialized across CLI `read --json`, MCP `read_doc`, and Web `/api/doc`.
public struct PublicDocumentDetail: Hashable, Sendable, Codable {
    /// Single rendered section projected across the public boundary.
    public struct Section: Hashable, Sendable, Codable {
        public let kind: String
        public let heading: String?
        public let content: String

        public init(from record: DocumentSectionRecord) {
            self.kind = record.sectionKind
            self.heading = record.heading
            self.content = record.contentText
        }
    }

    public let document: PublicDocumentMetadata
    public let sections: [Section]

    /// Section kinds already rendered from document metadata (abstract, declaration) and therefore
    /// excluded from body rendering to avoid duplicated content.
    public static let metadataSectionKinds: Set<String> = ["abstract", "declaration"]

    /// Sections that form the page body (everything except metadata-derived kinds).
    public var bodySections: [Section] {
        sections.filter { !Self.metadataSectionKinds.contains($0.kind) }
    }

    public init(document: DocumentRecord, sections: [DocumentSectionRecord]) {
        self.document = PublicDocumentMetadata(from: document)
        self.sections = sections.map(Section.init)
    }

    /// Renders the document into clean offline Markdown (matching MCP `read_doc` and CLI `read`).
    public func renderMarkdown() -> String {
        var lines: [String] = ["# \(document.title)"]
        if let roleHeading = document.roleHeading, !roleHeading.isEmpty {
            lines.append("*\(roleHeading) — \(document.framework)*")
        } else {
            lines.append("*\(document.framework)*")
        }
        if let abstract = document.abstract, !abstract.isEmpty {
            lines.append("")
            lines.append(abstract)
        }
        if let declaration = document.declaration, !declaration.isEmpty {
            lines.append("")
            lines.append("```swift")
            lines.append(declaration)
            lines.append("```")
        }
        for section in bodySections {
            lines.append("")
            if let heading = section.heading, !heading.isEmpty {
                lines.append("## \(heading)")
                lines.append("")
            }
            lines.append(section.content)
        }
        return lines.joined(separator: "\n")
    }
}
