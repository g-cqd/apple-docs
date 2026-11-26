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
    public let framework: PublicFrameworkSummary?
    public let related: [PublicRelatedDocument]
    public let children: [PublicDocumentSummary]
    /// Display name of the page's framework: the root's display name, else its root page title, else the slug.
    public let frameworkName: String

    /// Loads the view for `key`.
    ///
    /// - Parameters:
    ///   - key: the page's document key.
    ///   - store: the corpus to read.
    ///   - roots: the corpus roots when the caller already has them (static export), else read here.
    /// - Returns: the view, or `nil` when neither a document nor a framework root lives at `key`.
    /// - Throws: ``SQLiteError`` when a corpus query fails.
    public static func load(
        key: DocumentKey,
        store: CorpusStore,
        roots: [CorpusRootRecord]? = nil
    ) throws(SQLiteError) -> WebDocumentView? {
        let slug = key.rootSlug
        let document = try store.document(forKey: key)
        let allRoots: [CorpusRootRecord]
        if let roots { allRoots = roots } else { allRoots = try store.listRoots() }
        let framework = allRoots.first { $0.slug == slug }.map(PublicFrameworkSummary.init)
        guard document != nil || (framework != nil && key.rawValue == slug) else { return nil }
        let records = document == nil ? [] : try store.sections(forKey: key)
        let related =
            document == nil ? [] : try CorpusQueryService.relatedDocuments(forKey: key, on: store.connection)
        let linked = Set(related.map(\.path))
        let children = try CorpusQueryService.childDocuments(of: key, on: store.connection)
        var frameworkName = framework?.displayName ?? slug
        if frameworkName == slug, let rootKey = try? DocumentKey(slug) {
            let rootDocument = rootKey == key ? document : try store.document(forKey: rootKey)
            frameworkName = rootDocument?.title ?? slug
        }
        return WebDocumentView(
            key: key,
            detail: document.map { PublicDocumentDetail(document: $0, sections: records) },
            sections: records.filter { !PublicDocumentDetail.metadataSectionKinds.contains($0.sectionKind) }
                .map(WebDocumentSection.init),
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
