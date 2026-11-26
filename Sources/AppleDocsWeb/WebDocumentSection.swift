public import AppleDocsCore

/// One stored section as the web page renders it: Markdown text plus the optional structured payload
/// (`content_json`, present for Bun-imported corpora) that renders richer than the flattened text.
public struct WebDocumentSection: Sendable {
    public let kind: String
    public let heading: String?
    public let content: String
    public let contentJSON: String?

    public init(from record: DocumentSectionRecord) {
        self.kind = record.sectionKind
        self.heading = record.heading
        self.content = record.contentText
        self.contentJSON = record.contentJSON
    }
}
