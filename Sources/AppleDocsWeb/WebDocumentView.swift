import AppleDocsCommands
public import AppleDocsCore
public import AppleDocsOutput
public import AppleDocsStorage

/// Everything a `/doc/<key>` page shows: the document (absent for a framework without a root page), its body
/// sections, its framework, its outgoing relationships (topics, see also, conformances), and direct children.
public struct WebDocumentView: Sendable {
    public let key: DocumentKey
    public let detail: PublicDocumentDetail?
    public let sections: [WebDocumentSection]
    /// Declaration variants by language (more than one enables the Swift / Objective-C toggle).
    public let declarations: [WebDeclaration]
    public let framework: PublicFrameworkSummary?
    public let related: [PublicRelatedDocument]
    public let children: [PublicDocumentSummary]
    /// Display name of the page's framework: the root's display name, else its root page title, else the slug.
    public let frameworkName: String

    /// Loads the view for `key`.
    public static func load(
        key: DocumentKey,
        store: CorpusStore,
        roots: [CorpusRootRecord]? = nil,
        rootsBySlug: [String: CorpusRootRecord]? = nil,
        rootTitlesBySlug: [String: String]? = nil
    ) throws(SQLiteError) -> WebDocumentView? {
        let slug = key.rootSlug
        let found = try store.documentWithID(forKey: key)
        let document = found?.document
        let rootRecord: CorpusRootRecord?
        if let rootsBySlug {
            rootRecord = rootsBySlug[slug]
        } else if let roots {
            rootRecord = roots.first { $0.slug == slug }
        } else {
            rootRecord = try store.listRoots().first { $0.slug == slug }
        }
        let framework = rootRecord.map(PublicFrameworkSummary.init)
        guard document != nil || (framework != nil && key.rawValue == slug) else { return nil }
        let records = try found.map { item throws(SQLiteError) in try store.sections(forDocumentID: item.id) } ?? []
        let related =
            document == nil ? [] : try CorpusQueryService.relatedDocuments(forKey: key, on: store.connection)
        let linked = Set(related.map(\.path))
        let children = try CorpusQueryService.childDocuments(of: key, on: store.connection)
        var frameworkName = framework?.displayName ?? slug
        if frameworkName == slug {
            if let cachedTitle = rootTitlesBySlug?[slug] {
                frameworkName = cachedTitle
            } else if let rootKey = try? DocumentKey(slug) {
                let rootDocument = rootKey == key ? document : try store.document(forKey: rootKey)
                frameworkName = rootDocument?.title ?? slug
            }
        }
        return WebDocumentView(
            key: key,
            detail: document.map { PublicDocumentDetail(document: $0, sections: records) },
            sections: records.filter { !PublicDocumentDetail.metadataSectionKinds.contains($0.sectionKind) }
                .map(WebDocumentSection.init),
            declarations: WebDeclaration.variants(in: records),
            framework: framework,
            related: related,
            children: children.filter { !linked.contains($0.path) },
            frameworkName: frameworkName
        )
    }

    /// Page title: the document's title, else the framework's display name.
    public var title: String {
        detail?.document.title ?? frameworkName
    }
}
