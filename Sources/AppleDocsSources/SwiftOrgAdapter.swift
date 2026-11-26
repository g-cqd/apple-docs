import AppleDocsContent
public import AppleDocsCore

/// Curated Swift.org HTML documentation pages (`https://swift.org/...` — Bun `sources/swift-org.js`).
public struct SwiftOrgAdapter: SourceAdapter, Sendable {
    static let rootSlug = "swift-org"

    struct CrossLink: Sendable {
        let key: String
        let title: String
        let summary: String
        let parents: Set<String>
    }

    // @dl:disable -- SourceAdapter conformance properties
    public init() {}

    public var kind: SourceKind { .swiftOrg }
    public var displayName: String { "Swift.org Documentation" }

    public var defaultRoot: CorpusRootRecord {
        AdapterHelpers.collectionRoot(
            slug: Self.rootSlug,
            displayName: displayName,
            sourceType: .swiftOrg,
            seedPath: "swift-org/documentation"
        )
    }

    public var seedKeys: [DocumentKey] {
        Self.curatedPaths.compactMap { try? DocumentKey("\(Self.rootSlug)/\($0)") }
    }

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        let rest = try AdapterHelpers.stripRootPrefix(Self.rootSlug, from: key)
        return "https://swift.org/\(rest)"
    }
    // @dl:enable

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let url = try dataURL(for: key)
        return try await AdapterHelpers.fetchTransformed(url: url, previousETag: previousETag, client: client) {
            response in
            let convertedPage = HTMLDocumentConverter.convert(
                html: response.body,
                key: key,
                sourceType: .swiftOrg,
                fallbackTitle: key.rawValue,
                url: url
            )
            let cleanTitle = Self.stripBrandSuffix(convertedPage.document.title)
            var sections = convertedPage.sections
            var relationships: [DocumentRelationshipRecord] = []
            Self.appendCrossLinks(for: key, sections: &sections, relationships: &relationships)

            let doc = DocumentRecord(
                key: key,
                sourceType: .swiftOrg,
                title: cleanTitle,
                kind: "article",
                role: "article",
                framework: Self.rootSlug,
                url: url,
                abstractText: convertedPage.document.abstractText,
                headings: convertedPage.document.headings,
                urlDepth: convertedPage.document.urlDepth
            )
            return (ConvertedDocument(document: doc, sections: sections, relationships: relationships), [])
        }
    }
}
