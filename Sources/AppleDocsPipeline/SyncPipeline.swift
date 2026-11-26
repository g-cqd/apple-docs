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
        var totals = (documents: 0, sections: 0, relationships: 0)
        var failureCount = 0
        try store.connection.transaction {
            try store.upsertRoot(root)
            for payload in payloads {
                do {
                    let converted = try persist(payload, into: store)
                    totals.documents += 1
                    totals.sections += converted.sections.count
                    totals.relationships += converted.relationships.count
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
                bindings: [.text("root:\(root.slug):last_count"), .text(String(totals.documents))]
            )
        }
        return IngestReport(
            documentsIngested: totals.documents,
            sectionsIngested: totals.sections,
            relationshipsIngested: totals.relationships,
            failures: failureCount
        )
    }

    /// Converts one payload and writes its document, sections, and relationships (caller owns the transaction).
    @discardableResult
    static func persist(_ payload: SourcePayload, into store: CorpusStore) throws -> ConvertedDocument {
        let converted = try convert(payload)
        let docID = try store.upsertDocument(converted.document)
        try store.replaceSections(forDocumentID: docID, sections: converted.sections)
        for relationship in converted.relationships {
            try store.upsertRelationship(relationship)
        }
        return converted
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
