public import AppleDocsCore

/// Normalized result produced by every content converter (`DocCJSONConverter`, `HTMLDocumentConverter`,
/// `MarkdownDocumentConverter`), carrying the document record, ordered sections, and extracted
/// outgoing relationship edges.
public struct ConvertedDocument: Hashable, Sendable {
    public let document: DocumentRecord
    public let sections: [DocumentSectionRecord]
    public let relationships: [DocumentRelationshipRecord]

    public init(
        document: DocumentRecord,
        sections: [DocumentSectionRecord],
        relationships: [DocumentRelationshipRecord] = []
    ) {
        self.document = document
        self.sections = sections
        self.relationships = relationships
    }

    /// Accumulates heading-delimited section paragraphs/blocks into ordered ``DocumentSectionRecord`` entries.
    public struct SectionBuilder {
        private var currentHeading: String?
        private var currentBlocks: [String] = []
        private var built: [DocumentSectionRecord] = []
        private let startOrder: Int

        public init(startingOrder: Int = 0) {
            self.startOrder = startingOrder
        }

        public mutating func startSection(heading: String?) {
            flush()
            currentHeading = heading
        }

        public mutating func appendBlock(_ text: String) {
            guard !text.isEmpty else { return }
            currentBlocks.append(text)
        }

        public mutating func finish() -> [DocumentSectionRecord] {
            flush()
            return built
        }

        private mutating func flush() {
            guard !currentBlocks.isEmpty else { return }
            built.append(
                DocumentSectionRecord(
                    sectionKind: built.isEmpty && currentHeading == nil ? "overview" : "discussion",
                    heading: currentHeading,
                    contentText: currentBlocks.joined(separator: "\n\n"),
                    sortOrder: startOrder + built.count
                )
            )
            currentBlocks.removeAll(keepingCapacity: true)
        }
    }
}
