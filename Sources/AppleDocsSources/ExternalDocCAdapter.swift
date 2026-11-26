import AemiJSONCore
import AppleDocsContent
public import AppleDocsCore
import Foundation
import Synchronization

/// DocC archives Apple references from outside `developer.apple.com` — CareKit, Private Cloud Compute,
/// Swift's DocC manual, plus any external HTTPS DocC destination in `technologies.json`
/// (Bun `sources/external-docc.js`).
public final class ExternalDocCAdapter: SourceAdapter, Sendable {
    public struct Archive: Hashable, Sendable {
        public let slug: String
        public let displayName: String
        public let rootKind: String
        public let baseURL: String
    }

    // @dl:disable -- curated external DocC archive manifest
    public static let curated: [Archive] = [
        Archive(
            slug: "carekit",
            displayName: "CareKit",
            rootKind: "framework",
            baseURL: "https://carekit-apple.github.io/CareKit"
        ),
        Archive(
            slug: "private-cloud-compute",
            displayName: "Private Cloud Compute Security Guide",
            rootKind: "guide",
            baseURL: "https://security.apple.com"
        ),
        Archive(slug: "docc", displayName: "DocC", rootKind: "tooling", baseURL: "https://www.swift.org")
    ]
    // @dl:enable

    private let archives: Mutex<[String: Archive]>

    // @dl:disable -- SourceAdapter conformance properties
    public init() {
        self.archives = Mutex(Dictionary(uniqueKeysWithValues: Self.curated.map { ($0.slug, $0) }))
    }

    public var kind: SourceKind { .externalDocC }
    public var displayName: String { "External DocC Archives" }

    public var defaultRoot: CorpusRootRecord {
        let first = Self.curated[0]
        return AdapterHelpers.collectionRoot(
            slug: first.slug,
            displayName: first.displayName,
            kind: first.rootKind,
            sourceType: .externalDocC,
            seedPath: first.slug
        )
    }

    public var seedKeys: [DocumentKey] {
        Self.curated.compactMap { try? DocumentKey($0.slug) }
    }
    // @dl:enable

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        let archive = try resolveArchive(for: key)
        return "\(archive.baseURL)/data/documentation/\(key.rawValue).json"
    }

    public func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery {
        await detectFromTechnologies(client: client)
        let current = archives.withLock { $0.values.sorted { $0.slug < $1.slug } }
        var roots: [CorpusRootRecord] = []
        var keys: [DocumentKey] = []
        var seen: Set<String> = []
        for archive in current {
            roots.append(
                AdapterHelpers.collectionRoot(
                    slug: archive.slug,
                    displayName: archive.displayName,
                    kind: archive.rootKind,
                    sourceType: .externalDocC,
                    seedPath: archive.slug
                )
            )
            for key in await enumerate(archive: archive, client: client) where seen.insert(key.rawValue).inserted {
                keys.append(key)
            }
        }
        return SourceDiscovery(roots: roots, keys: keys)
    }

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let archive = try resolveArchive(for: key)
        let slug = archive.slug
        return try await AdapterHelpers.fetchDocCArchivePage(
            url: "\(archive.baseURL)/data/documentation/\(key.rawValue).json",
            pageURL: "\(archive.baseURL)/documentation/\(key.rawValue)",
            key: key,
            sourceType: .externalDocC,
            previousETag: previousETag,
            client: client,
            filterDiscovered: { $0.rootSlug == slug }
        )
    }

    private func resolveArchive(for key: DocumentKey) throws(SourceError) -> Archive {
        guard let archive = archives.withLock({ $0[key.rootSlug] }) else {
            throw .unknownSource("Unknown external-docc archive: \(key.rootSlug)")
        }
        return archive
    }

    private func detectFromTechnologies(client: UpstreamHTTPClient) async {
        guard let response = try? await client.get(url: AppleRootCatalog.technologiesURL),
            (200 ... 299).contains(response.statusCode),
            let root = try? AemiJSON.parse(response.body).root
        else { return }
        var seen: Set<String> = archives.withLock { Set($0.keys) }
        for section in root["sections"].array ?? [] {
            for group in section["groups"].array ?? [] {
                for tech in group["technologies"].array ?? [] {
                    guard let id = tech["destination"]["identifier"].string,
                        let parsed = Self.parseDocCArchiveURL(id),
                        seen.insert(parsed.slug).inserted
                    else { continue }
                    let probeURL = "\(parsed.baseURL)/data/documentation/\(parsed.entryKey).json"
                    if let probe = try? await client.get(url: probeURL),
                        (200 ... 299).contains(probe.statusCode),
                        let doc = try? AemiJSON.parse(probe.body).root,
                        doc["schemaVersion"].isObject
                    {
                        let archive = Archive(
                            slug: parsed.slug,
                            displayName: tech["title"].string ?? parsed.slug,
                            rootKind: "framework",
                            baseURL: parsed.baseURL
                        )
                        archives.withLock { $0[parsed.slug] = archive }
                    }
                }
            }
        }
    }

    private func enumerate(archive: Archive, client: UpstreamHTTPClient) async -> [DocumentKey] {
        let indexURL = "\(archive.baseURL)/index/index.json"
        if let response = try? await client.get(url: indexURL), (200 ... 299).contains(response.statusCode),
            let paths = try? SwiftDocCAdapter.collectIndexPaths(from: response.body)
        {
            var keys: [DocumentKey] = []
            var seen: Set<String> = []
            for path in paths {
                guard let key = Self.indexPathToKey(path), key.rootSlug == archive.slug,
                    seen.insert(key.rawValue).inserted
                else { continue }
                keys.append(key)
            }
            if !keys.isEmpty { return keys }
        }
        return await enumerateBFS(archive: archive, client: client)
    }

    private func enumerateBFS(archive: Archive, client: UpstreamHTTPClient) async -> [DocumentKey] {
        guard let seed = try? DocumentKey(archive.slug) else { return [] }
        var visited: Set<String> = []
        var valid: [DocumentKey] = []
        var queue: [DocumentKey] = [seed]
        var cursor = 0
        while cursor < queue.count, visited.count < 5_000 {
            let key = queue[cursor]
            cursor += 1
            guard visited.insert(key.rawValue).inserted else { continue }
            let url = "\(archive.baseURL)/data/documentation/\(key.rawValue).json"
            guard let response = try? await client.get(url: url), (200 ... 299).contains(response.statusCode),
                let converted = try? DocCJSONConverter.convert(
                    json: response.body,
                    key: key,
                    sourceType: .externalDocC
                )
            else { continue }
            valid.append(key)
            for child in converted.discoveredKeys
            where child.rootSlug == archive.slug && !visited.contains(child.rawValue) {
                queue.append(child)
            }
        }
        return valid
    }

    private static func indexPathToKey(_ path: String) -> DocumentKey? {
        let lower = path.lowercased()
        guard lower.hasPrefix("/documentation/") else { return nil }
        let rest = String(lower.dropFirst("/documentation/".count))
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return try? DocumentKey(rest)
    }

    private static func parseDocCArchiveURL(_ raw: String) -> (slug: String, baseURL: String, entryKey: String)? {
        guard let url = URL(string: raw), url.scheme == "https", let host = url.host?.lowercased(),
            host != "developer.apple.com", !host.hasSuffix(".developer.apple.com"),
            let range = url.path.range(of: "/documentation/")
        else { return nil }
        let prefix = String(url.path[..<range.lowerBound])
        let rest = String(url.path[range.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .lowercased()
        guard !rest.isEmpty,
            !rest.split(separator: "/").contains(where: { WebSourceAdapter.isOperatorSegment(String($0)) }),
            let slug = rest.split(separator: "/").first.map(String.init)
        else { return nil }
        let port = url.port.map { ":\($0)" } ?? ""
        return (slug, "https://\(url.host ?? host)\(port)\(prefix)", rest)
    }
}
