import AppleDocsContent
public import AppleDocsCore
/// Apple Developer Archive (`https://developer.apple.com/library/archive/navigation/library.json` —
/// Bun `sources/apple-archive.js`).
import Synchronization

public final class AppleArchiveAdapter: SourceAdapter, Sendable {
    public static let libraryURL = "https://developer.apple.com/library/archive/navigation/library.json"
    static let archiveBase = "https://developer.apple.com/library/archive"
    static let rootSlug = "apple-archive"

    static let knownMissingPaths: Set<String> = [
        "documentation/Hardware/hardware2.html",
        "documentation/Hardware/legacy/legacy.html",
        "documentation/Carbon/Conceptual/DesktopIcons/ch13.html",
        "documentation/Carbon/Conceptual/DragMgrProgrammersGuide/DragMgrProgrammersGuide.pdf",
        "documentation/General/Conceptual/Apple_News_Format_Ref/index.html",
        "documentation/General/Conceptual/News_API_Ref/index.html",
        "documentation/Performance/Conceptual/Mac_OSX_Numerics/Mac_OSX_Numerics.pdf",
        "documentation/General/Conceptual/AppStoreSearchAdsAPIReference/index.html",
        "documentation/QuickTime/whatsnew.htm"
    ]

    struct GuideEntry: Sendable {
        let key: DocumentKey
        let title: String
        let url: String
        let format: String
        let sourceMetadataJSON: String
    }

    // @dl:disable -- SourceAdapter conformance properties
    private let catalog = Mutex<[String: GuideEntry]?>(nil)
    public init() {}

    public var kind: SourceKind { .appleArchive }
    public var displayName: String { "Apple Developer Archive" }

    public var defaultRoot: CorpusRootRecord {
        AdapterHelpers.collectionRoot(
            slug: Self.rootSlug,
            displayName: displayName,
            sourceType: .appleArchive,
            seedPath: "apple-archive/documentation/cocoa/conceptual/cocoadrawingguide"
        )
    }

    public var seedKeys: [DocumentKey] {
        AdapterHelpers.singleSeed("apple-archive/documentation/cocoa/conceptual/cocoadrawingguide")
    }
    // @dl:enable

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        if let entry = catalog.withLock({ $0?[key.rawValue] }) {
            return entry.url
        }
        return try Self.fallbackURL(for: key)
    }

    public func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery {
        let guides = try await loadCatalog(client: client)
        let ordered = guides.values.map(\.key).sorted { $0.rawValue < $1.rawValue }
        return SourceDiscovery(roots: [defaultRoot], keys: ordered)
    }

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        if let previousETag, !previousETag.isEmpty {
            return .notModified
        }
        let guides = try await loadCatalog(client: client)
        let entry = guides[key.rawValue]
        let url: String
        if let entryURL = entry?.url {
            url = entryURL
        } else {
            url = try Self.fallbackURL(for: key)
        }
        let format = entry?.format ?? (url.lowercased().hasSuffix(".pdf") ? "pdf" : "html")
        let framework = Self.deriveFramework(key) ?? Self.rootSlug
        if format == "pdf" {
            return try await fetchPDFGuide(key: key, url: url, framework: framework, entry: entry, client: client)
        }
        return try await fetchHTMLGuide(key: key, url: url, framework: framework, entry: entry, client: client)
    }

    private func fetchPDFGuide(
        key: DocumentKey,
        url: String,
        framework: String,
        entry: GuideEntry?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let response = try await client.get(url: url, method: "HEAD")
        if response.isDeleted { return .notFound }
        guard (200 ... 299).contains(response.statusCode) else {
            throw .httpStatus(response.statusCode, url: url)
        }
        let title = entry?.title ?? key.rawValue.split(separator: "/").last.map(String.init) ?? key.rawValue
        let doc = DocumentRecord(
            key: key,
            sourceType: .appleArchive,
            title: title,
            kind: "archive-guide",
            role: "article",
            framework: framework,
            url: url,
            abstractText: "Archived PDF guide. Open the original PDF URL for the full document.",
            urlDepth: max(0, key.rawValue.split(separator: "/").count - 1),
            sourceMetadataJSON: entry?.sourceMetadataJSON
        )
        let section = DocumentSectionRecord(
            sectionKind: "discussion",
            heading: "Original PDF",
            contentText: "This archive guide is only available as a PDF.\n\nOpen the original document: \(url)",
            sortOrder: 0
        )
        return .modified(
            payload: SourcePayload(converted: ConvertedDocument(document: doc, sections: [section])),
            etag: response.etag ?? "\"frozen\"",
            discoveredKeys: []
        )
    }

    private func fetchHTMLGuide(
        key: DocumentKey,
        url: String,
        framework: String,
        entry: GuideEntry?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let response = try await client.get(url: url)
        if response.isDeleted { return .notFound }
        guard (200 ... 299).contains(response.statusCode) else {
            throw .httpStatus(response.statusCode, url: url)
        }
        let convertedPage = HTMLDocumentConverter.convert(
            html: response.body,
            key: key,
            sourceType: .appleArchive,
            fallbackTitle: entry?.title ?? key.rawValue,
            url: url
        )
        let doc = DocumentRecord(
            key: key,
            sourceType: .appleArchive,
            title: convertedPage.document.title,
            kind: "archive-guide",
            role: "article",
            framework: framework,
            url: url,
            abstractText: convertedPage.document.abstractText,
            headings: convertedPage.document.headings,
            urlDepth: convertedPage.document.urlDepth,
            sourceMetadataJSON: entry?.sourceMetadataJSON
        )
        return .modified(
            payload: SourcePayload(converted: ConvertedDocument(document: doc, sections: convertedPage.sections)),
            etag: response.etag ?? "\"frozen\"",
            discoveredKeys: []
        )
    }

    private func loadCatalog(client: UpstreamHTTPClient) async throws(SourceError) -> [String: GuideEntry] {
        if let existing = catalog.withLock({ $0 }) { return existing }
        let response = try await client.get(url: Self.libraryURL)
        guard (200 ... 299).contains(response.statusCode) else {
            throw .httpStatus(response.statusCode, url: Self.libraryURL)
        }
        let map = try Self.parseCatalog(body: response.body)
        catalog.withLock { $0 = map }
        return map
    }
}
