// CrawlPipeline — the persist boundary. Maps the adapter layer's dependency-free
// `ADBuilder.NormalizedPage` to `ADWrite.NormalizedDoc` (a 1:1 field copy — the field names match
// deliberately) and drives `CrawlPersist.persistNormalized`. This is the ONLY place the storage-bound
// ADWrite/ADDB graph meets the storage-free adapter + parser layer, so the adapters stay testable in
// isolation while the storage siblings churn.

public import ADBuilder
public import ADDB  // Database / DBError (MemberImportVisibility needs the declaring module)
public import ADWrite

public enum CrawlPipeline {
    /// Map the pure adapter output to ADWrite's persist input (field-for-field).
    public static func normalizedDoc(_ page: NormalizedPage) -> NormalizedDoc {
        NormalizedDoc(
            document: document(page.document),
            sections: page.sections.map(section),
            relationships: page.relationships.map(relationship))
    }

    /// Persist a normalized page: map + `CrawlPersist.persistNormalized`, in one ADDB transaction.
    /// `hashes` (content / raw-payload SHA-256) are the caller's — change-detection POLICY the crawl
    /// driver owns, not this boundary. `etag`/`lastModified` are the upstream HTTP validators the driver
    /// carries from `FetchResult`; they land in `pages.etag`/`last_modified` so the next re-crawl can read
    /// them back for a conditional check. Defaulted ⇒ the pure-mapping callers stay source-compatible.
    public static func persist(
        _ page: NormalizedPage, into db: Database, rootId: Int64, path: String,
        hashes: CrawlPersist.DocumentHashes, etag: String? = nil, lastModified: String? = nil, now: String
    ) throws {
        try CrawlPersist.persistNormalized(
            db, rootId: rootId, path: path, normalizedDoc(page), hashes: hashes,
            etag: etag, lastModified: lastModified, now: now)
    }

    // MARK: - 1:1 field mapping (ADBuilder DTO -> ADWrite DTO)

    private static func document(_ d: ADBuilder.NormalizedDocument) -> ADWrite.NormalizedDocument {
        ADWrite.NormalizedDocument(
            sourceType: d.sourceType, key: d.key, title: d.title, kind: d.kind, role: d.role,
            roleHeading: d.roleHeading, framework: d.framework, url: d.url, language: d.language,
            abstractText: d.abstractText, declarationText: d.declarationText,
            platformsJson: d.platformsJson, minIos: d.minIos, minMacos: d.minMacos,
            minWatchos: d.minWatchos, minTvos: d.minTvos, minVisionos: d.minVisionos,
            isDeprecated: d.isDeprecated, isBeta: d.isBeta, isReleaseNotes: d.isReleaseNotes,
            urlDepth: d.urlDepth, headings: d.headings, sourceMetadata: d.sourceMetadata)
    }

    private static func section(_ s: ADBuilder.NormalizedSection) -> ADWrite.NormalizedSection {
        ADWrite.NormalizedSection(
            sectionKind: s.sectionKind, heading: s.heading, contentText: s.contentText,
            contentJson: s.contentJson, sortOrder: s.sortOrder)
    }

    private static func relationship(_ r: ADBuilder.NormalizedRelationship)
        -> ADWrite.NormalizedRelationship
    {
        ADWrite.NormalizedRelationship(
            fromKey: r.fromKey, toKey: r.toKey, relationType: r.relationType, section: r.section,
            sortOrder: r.sortOrder)
    }
}
