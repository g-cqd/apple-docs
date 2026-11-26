import AppleDocsContent
public import AppleDocsCore
public import AppleDocsSources
public import AppleDocsStorage

/// Deterministic, transactional corpus ingestion pipeline converting ``SourcePayload`` batches
/// (`DocC JSON`, `HTML`, `Markdown`) into a Swift v1 ``CorpusStore``, persisting sections,
/// extracted relationships, and checkpoint state.
public enum SyncPipeline: Sendable {
    /// Summary counts returned after ingesting a batch of upstream payloads.
    public struct IngestReport: Hashable, Sendable {
        public let documentsIngested: Int
        public let sectionsIngested: Int
        public let relationshipsIngested: Int
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
        var relCount = 0
        var failureCount = 0

        try store.connection.transaction {
            try store.upsertRoot(root)
            for payload in payloads {
                do {
                    let converted = try convert(payload)
                    let docID = try store.upsertDocument(converted.document)
                    try store.replaceSections(forDocumentID: docID, sections: converted.sections)
                    for relationship in converted.relationships {
                        try store.upsertRelationship(relationship)
                        relCount += 1
                    }
                    docCount += 1
                    sectionCount += converted.sections.count
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
        return IngestReport(
            documentsIngested: docCount,
            sectionsIngested: sectionCount,
            relationshipsIngested: relCount,
            failures: failureCount
        )
    }

    static func convert(_ payload: SourcePayload) throws -> ConvertedDocument {
        switch payload.encoding {
            case .doccJSON:
                return try DocCJSONConverter.convert(
                    json: payload.body,
                    key: payload.key,
                    sourceType: payload.sourceType,
                    url: payload.url
                )
            case .html:
                let page = HTMLDocumentConverter.convert(
                    html: payload.body,
                    key: payload.key,
                    sourceType: payload.sourceType,
                    fallbackTitle: payload.fallbackTitle,
                    url: payload.url
                )
                return ConvertedDocument(document: page.document, sections: page.sections)
            case .markdown:
                return MarkdownDocumentConverter.convert(
                    markdown: payload.body,
                    key: payload.key,
                    sourceType: payload.sourceType,
                    fallbackTitle: payload.fallbackTitle,
                    url: payload.url
                )
        }
    }
}
