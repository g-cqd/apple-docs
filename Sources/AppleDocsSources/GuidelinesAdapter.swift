import AppleDocsContent
public import AppleDocsCore
import Synchronization

/// App Store Review Guidelines (`https://developer.apple.com/app-store/review/guidelines/` —
/// Bun `sources/guidelines.js` + `apple/guidelines-parser.js`).
public final class GuidelinesAdapter: SourceAdapter, Sendable {
    public static let guidelinesURL = "https://developer.apple.com/app-store/review/guidelines/"
    static let rootSlug = "app-store-review"

    struct ParsedSection: Sendable {
        var id: String
        var key: DocumentKey
        var title: String
        var abstractText: String?
        var markdown: String
        var role: String
        var roleHeading: String
        var sectionNumber: String?
        var children: [DocumentKey] = []
    }

    struct Snapshot: Sendable {
        var etag: String?
        var sectionsByKey: [String: ParsedSection]
        var orderedKeys: [DocumentKey]
    }

    // @dl:disable -- SourceAdapter conformance properties
    private let cached = Mutex<Snapshot?>(nil)
    public init() {}

    public var kind: SourceKind { .guidelines }
    public var displayName: String { "App Store Review Guidelines" }

    public var defaultRoot: CorpusRootRecord {
        AdapterHelpers.collectionRoot(
            slug: Self.rootSlug,
            displayName: displayName,
            kind: "guidelines",
            sourceType: .guidelines,
            seedPath: "\(Self.rootSlug)/introduction"
        )
    }

    public var seedKeys: [DocumentKey] {
        AdapterHelpers.singleSeed("\(Self.rootSlug)/introduction")
    }
    // @dl:enable

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        Self.guidelinesURL
    }

    public func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery {
        let snap = try await loadSnapshot(client: client, previousETag: nil)
        return SourceDiscovery(roots: [defaultRoot], keys: snap.orderedKeys)
    }

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let snap: Snapshot
        if let existing = cached.withLock({ $0 }) {
            if let etag = existing.etag, previousETag == etag {
                return .notModified
            }
            snap = existing
        } else {
            switch try await client.conditionalGet(url: Self.guidelinesURL, etag: previousETag) {
                case .notModified: return .notModified
                case .gone: return .notFound
                case .ok(let response):
                    let built = Self.parseSnapshot(html: response.body, etag: response.etag)
                    cached.withLock { $0 = built }
                    snap = built
            }
        }
        guard let section = snap.sectionsByKey[key.rawValue] else {
            return .notFound
        }
        let converted = Self.toConvertedDocument(section)
        return .modified(payload: SourcePayload(converted: converted), etag: snap.etag, discoveredKeys: [])
    }

    private func loadSnapshot(client: UpstreamHTTPClient, previousETag: String?) async throws(SourceError) -> Snapshot {
        let response = try await client.get(url: Self.guidelinesURL, ifNoneMatch: previousETag)
        guard (200 ... 299).contains(response.statusCode) else {
            throw .httpStatus(response.statusCode, url: Self.guidelinesURL)
        }
        let built = Self.parseSnapshot(html: response.body, etag: response.etag)
        cached.withLock { $0 = built }
        return built
    }

    private static func toConvertedDocument(_ section: ParsedSection) -> ConvertedDocument {
        let pageURL = "\(guidelinesURL)#\(section.id)"
        var sections: [DocumentSectionRecord] = []
        if let abstractText = section.abstractText, !abstractText.isEmpty {
            sections.append(
                DocumentSectionRecord(
                    sectionKind: "abstract",
                    heading: nil,
                    contentText: abstractText,
                    sortOrder: sections.count
                )
            )
        }
        if !section.markdown.isEmpty {
            sections.append(
                DocumentSectionRecord(
                    sectionKind: "discussion",
                    heading: "Overview",
                    contentText: section.markdown,
                    sortOrder: sections.count
                )
            )
        }
        let relationships = section.children.enumerated()
            .map { idx, child in
                DocumentRelationshipRecord(
                    fromKey: section.key,
                    toKey: child,
                    relationType: "child",
                    section: "Topics",
                    sortOrder: idx
                )
            }
        let doc = DocumentRecord(
            key: section.key,
            sourceType: .guidelines,
            title: section.title,
            kind: section.role,
            role: section.role,
            roleHeading: section.roleHeading,
            framework: rootSlug,
            url: pageURL,
            abstractText: section.abstractText,
            urlDepth: max(0, section.key.rawValue.split(separator: "/").count - 1)
        )
        return ConvertedDocument(document: doc, sections: sections, relationships: relationships)
    }
}
