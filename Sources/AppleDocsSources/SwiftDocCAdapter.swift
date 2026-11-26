import AemiJSONCore
import AppleDocsContent
public import AppleDocsCore

/// DocC archives published outside `developer.apple.com` on `docs.swift.org` / `www.swift.org`
/// (`swift-compiler`, `swift-package-manager`, `swift-migration-guide` — Bun `sources/swift-docc.js`).
public struct SwiftDocCAdapter: SourceAdapter, Sendable {
    public struct Archive: Hashable, Sendable {
        public let slug: String
        public let displayName: String
        public let rootKind: String
        public let baseURL: String
        public let entryKey: String
        public let entryTitle: String
        public let entrySummary: String
        public let parents: [String]
    }

    // @dl:disable -- curated Swift.org DocC archive manifest
    public static let archives: [Archive] = [
        Archive(
            slug: "swift-compiler",
            displayName: "Swift Compiler",
            rootKind: "tooling",
            baseURL: "https://docs.swift.org/compiler",
            entryKey: "swift-compiler/documentation/diagnostics",
            entryTitle: "Swift Compiler Diagnostics",
            entrySummary:
                "Reference for warnings and errors emitted by the Swift compiler, including diagnostic groups and upcoming language features.",
            parents: ["swift-org/documentation", "swift-org/documentation/swift-compiler"]
        ),
        Archive(
            slug: "swift-package-manager",
            displayName: "Swift Package Manager",
            rootKind: "tooling",
            baseURL: "https://docs.swift.org/swiftpm",
            entryKey: "swift-package-manager/documentation/packagemanagerdocs",
            entryTitle: "Swift Package Manager",
            entrySummary:
                "Full reference for the Swift Package Manager: package manifests, dependencies, build settings, and plug-in APIs.",
            parents: ["swift-org/documentation", "swift-org/getting-started"]
        ),
        Archive(
            slug: "swift-migration-guide",
            displayName: "Swift 6 Concurrency Migration Guide",
            rootKind: "guide",
            baseURL: "https://www.swift.org/migration",
            entryKey: "swift-migration-guide/documentation/migrationguide",
            entryTitle: "Swift 6 Concurrency Migration Guide",
            entrySummary:
                "How to migrate existing Swift code to the Swift 6 concurrency model, including data-race safety and incremental adoption.",
            parents: ["swift-org/documentation"]
        )
    ]
    // @dl:enable

    private static let bySlug: [String: Archive] = Dictionary(uniqueKeysWithValues: archives.map { ($0.slug, $0) })

    // @dl:disable -- SourceAdapter conformance properties
    public init() {}

    public var kind: SourceKind { .swiftDocC }
    public var displayName: String { "Swift Documentation Archives" }

    public var defaultRoot: CorpusRootRecord {
        let first = Self.archives[0]
        return AdapterHelpers.collectionRoot(
            slug: first.slug,
            displayName: first.displayName,
            kind: first.rootKind,
            sourceType: .swiftDocC,
            seedPath: first.entryKey
        )
    }

    public var seedKeys: [DocumentKey] {
        Self.archives.compactMap { try? DocumentKey($0.entryKey) }
    }
    // @dl:enable

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        let (archive, internalPath) = try resolveArchive(for: key)
        return "\(archive.baseURL)/data\(internalPath).json"
    }

    public func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery {
        let roots = Self.archives.map { archive in
            AdapterHelpers.collectionRoot(
                slug: archive.slug,
                displayName: archive.displayName,
                kind: archive.rootKind,
                sourceType: .swiftDocC,
                seedPath: archive.entryKey
            )
        }
        var keys: [DocumentKey] = []
        var seen: Set<String> = []
        for archive in Self.archives {
            let indexURL = "\(archive.baseURL)/index/index.json"
            guard let response = try? await client.get(url: indexURL), (200 ... 299).contains(response.statusCode),
                let paths = try? Self.collectIndexPaths(from: response.body)
            else { continue }
            for path in paths {
                let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
                let rawKey = "\(archive.slug)/\(trimmed.lowercased())"
                if seen.insert(rawKey).inserted, let docKey = try? DocumentKey(rawKey) {
                    keys.append(docKey)
                }
            }
        }
        return SourceDiscovery(roots: roots, keys: keys)
    }

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let (archive, internalPath) = try resolveArchive(for: key)
        let slug = archive.slug
        return try await AdapterHelpers.fetchDocCArchivePage(
            url: "\(archive.baseURL)/data\(internalPath).json",
            pageURL: "\(archive.baseURL)\(internalPath)",
            key: key,
            sourceType: .swiftDocC,
            previousETag: previousETag,
            client: client,
            keyMapper: { $0.hasPrefix("\(slug)/") ? $0 : "\(slug)/documentation/\($0)" }
        )
    }

    public static func collectIndexPaths(from bytes: [UInt8]) throws -> [String] {
        let root = try AemiJSON.parse(bytes).root
        var out: [String] = []
        func walk(_ node: JSON) {
            if let path = node["path"].string, !path.isEmpty { out.append(path) }
            for child in node["children"].array ?? [] { walk(child) }
        }
        for node in root["interfaceLanguages"]["swift"].array ?? [] { walk(node) }
        return out
    }

    private func resolveArchive(for key: DocumentKey) throws(SourceError) -> (Archive, String) {
        let slug = key.rootSlug
        guard let archive = Self.bySlug[slug] else {
            throw .unknownSource("Unknown swift-docc archive slug: \(slug)")
        }
        let rest = try AdapterHelpers.stripRootPrefix(slug, from: key)
        return (archive, "/\(rest)")
    }
}
