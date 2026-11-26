import AppleDocsContent
public import AppleDocsCore
public import AppleDocsSources
public import AppleDocsStorage

/// Deterministic, transactional corpus ingestion pipeline converting ``SourcePayload`` batches
/// (`DocC JSON`, `HTML`, `Markdown`) into a Swift v1 ``CorpusStore`` with checkpoint tracking.
public enum SyncPipeline: Sendable {
    /// Summary counts returned after ingesting a batch of upstream payloads.
    public struct IngestReport: Hashable, Sendable {
        public let documentsIngested: Int
        public let sectionsIngested: Int
        public let failures: Int
    }

    /// Converts and upserts `payloads` atomically into `store`, recording a phase checkpoint.
    public static func ingest(
        payloads: [SourcePayload],
        root: CorpusRootRecord,
        into store: CorpusStore
    ) throws -> IngestReport {
        var docCount = 0
        var sectionCount = 0
        var failureCount = 0

        try store.connection.transaction {
            try store.upsertRoot(root)
            for payload in payloads {
                do {
                    let (doc, sections) = try convert(payload)
                    let docID = try store.upsertDocument(doc)
                    try store.replaceSections(forDocumentID: docID, sections: sections)
                    docCount += 1
                    sectionCount += sections.count
                } catch {
                    failureCount += 1
                }
            }
            try store.connection.execute(
                """
                INSERT INTO sync_checkpoint (key, value, updated_at)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
                """,
                bindings: [.text("root:\(root.slug):last_count"), .text(String(docCount))]
            )
        }
        return IngestReport(documentsIngested: docCount, sectionsIngested: sectionCount, failures: failureCount)
    }

    private static func convert(_ payload: SourcePayload) throws -> (DocumentRecord, [DocumentSectionRecord]) {
        switch payload.encoding {
            case .doccJSON:
                let node = try DocCJSONConverter.convert(
                    json: payload.body,
                    key: payload.key,
                    sourceType: payload.sourceType,
                    url: payload.url
                )
                return (node.document, node.sections)
            case .html:
                let page = HTMLDocumentConverter.convert(
                    html: payload.body,
                    key: payload.key,
                    sourceType: payload.sourceType,
                    fallbackTitle: payload.fallbackTitle,
                    url: payload.url
                )
                return (page.document, page.sections)
            case .markdown:
                let md = MarkdownDocumentConverter.convert(
                    markdown: payload.body,
                    key: payload.key,
                    sourceType: payload.sourceType,
                    fallbackTitle: payload.fallbackTitle,
                    url: payload.url
                )
                return (md.document, md.sections)
        }
    }
}
