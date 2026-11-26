public import AppleDocsCore
import Foundation
import Synchronization

/// WWDC sessions: Apple video HTML pages (`2020+`) and ASCIIwwdc community transcripts (`1997-2019`)
/// (Bun `sources/wwdc.js`).
// @dl:disable -- adapter header + SourceAdapter conformance properties
public final class WWDCAdapter: SourceAdapter, Sendable {
    static let rootSlug = "wwdc"
    static let appleVideosIndex = "https://developer.apple.com/videos"
    static let applePlayBase = "https://developer.apple.com/videos/play"
    static let asciiOwner = "ASCIIwwdc"
    static let asciiRepo = "wwdc-session-transcripts"
    static let asciiBranch = "master"

    public static var appleYears: [Int] {
        let current = Calendar(identifier: .gregorian).component(.year, from: Date())
        return Array(2020 ... max(2020, current))
    }

    private let tracksByYear = Mutex<[Int: [String: String]]>([:])

    public init() {}

    public var kind: SourceKind { .wwdc }
    public var displayName: String { "WWDC Sessions" }

    public var defaultRoot: CorpusRootRecord {
        AdapterHelpers.collectionRoot(
            slug: Self.rootSlug,
            displayName: displayName,
            sourceType: .wwdc,
            seedPath: "wwdc/wwdc2024-10001"
        )
    }

    public var seedKeys: [DocumentKey] {
        AdapterHelpers.singleSeed("wwdc/wwdc2024-10001")
    }
    // @dl:enable

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        let (year, sessionID) = try Self.parseKey(key)
        if year >= 2020 {
            return "\(Self.applePlayBase)/wwdc\(year)/\(sessionID)/"
        }
        return GitHubClient.rawURL(
            owner: Self.asciiOwner,
            repo: Self.asciiRepo,
            branch: Self.asciiBranch,
            filePath: "en/\(year)/\(sessionID).vtt"
        )
    }

    public func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery {
        var keys: [DocumentKey] = []
        var seen: Set<String> = []

        for year in Self.appleYears {
            let url = "\(Self.appleVideosIndex)/wwdc\(year)/"
            guard let response = try? await client.get(url: url), (200 ... 299).contains(response.statusCode) else {
                continue
            }
            let parsed = Self.parseYearIndex(html: response.body, year: year)
            tracksByYear.withLock { $0[year] = parsed.tracks }
            for sessionID in parsed.sessionIDs {
                appendSessionKey(year: year, sessionID: sessionID, seen: &seen, into: &keys)
            }
        }

        if let tree = try? await GitHubClient.fetchTree(
            owner: Self.asciiOwner,
            repo: Self.asciiRepo,
            branch: Self.asciiBranch,
            client: client
        ) {
            for entry in tree where entry.type == "blob" && entry.path.hasPrefix("en/") && entry.path.hasSuffix(".vtt")
            {
                let parts = entry.path.split(separator: "/")
                guard parts.count == 3, let year = Int(parts[1]), (1997 ... 2019).contains(year) else { continue }
                let sessionID = String(parts[2].dropLast(".vtt".count))
                guard !sessionID.isEmpty, sessionID.allSatisfy(\.isNumber) else { continue }
                appendSessionKey(year: year, sessionID: sessionID, seen: &seen, into: &keys)
            }
        }

        return SourceDiscovery(roots: [defaultRoot], keys: keys)
    }

    private func appendSessionKey(
        year: Int,
        sessionID: String,
        seen: inout Set<String>,
        into keys: inout [DocumentKey]
    ) {
        let raw = "\(Self.rootSlug)/wwdc\(year)-\(sessionID)"
        if seen.insert(raw).inserted, let key = try? DocumentKey(raw) {
            keys.append(key)
        }
    }

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let (year, sessionID) = try Self.parseKey(key)
        let url = try dataURL(for: key)
        if year >= 2020 {
            return try await AdapterHelpers.fetchTransformed(url: url, previousETag: previousETag, client: client) {
                response in
                let track = await lookupTrack(year: year, sessionID: sessionID, client: client)
                return (
                    Self.normalizeAppleSession(
                        key: key,
                        html: response.body,
                        year: year,
                        sessionID: sessionID,
                        track: track
                    ),
                    []
                )
            }
        }
        return try await AdapterHelpers.fetchTransformed(
            url: url,
            previousETag: previousETag,
            headers: GitHubClient.rawHeaders(),
            client: client
        ) { response in
            (
                Self.normalizeAsciiSession(
                    key: key,
                    rawText: String(decoding: response.body, as: UTF8.self),
                    year: year,
                    sessionID: sessionID
                ),
                []
            )
        }
    }

    private func lookupTrack(year: Int, sessionID: String, client: UpstreamHTTPClient) async -> String? {
        if let existing = tracksByYear.withLock({ $0[year] }) {
            return existing[sessionID]
        }
        let url = "\(Self.appleVideosIndex)/wwdc\(year)/"
        guard let response = try? await client.get(url: url), (200 ... 299).contains(response.statusCode) else {
            tracksByYear.withLock { $0[year] = [:] }
            return nil
        }
        let parsed = Self.parseYearIndex(html: response.body, year: year)
        tracksByYear.withLock { $0[year] = parsed.tracks }
        return parsed.tracks[sessionID]
    }

    static func parseKey(_ key: DocumentKey) throws(SourceError) -> (Int, String) {
        let prefix = "wwdc/wwdc"
        guard key.rawValue.hasPrefix(prefix) else {
            throw .unsafeURL(key.rawValue, reason: "Invalid WWDC key")
        }
        let rest = key.rawValue.dropFirst(prefix.count)
        let parts = rest.split(separator: "-", maxSplits: 1)
        guard parts.count == 2, parts[0].count == 4, let year = Int(parts[0]),
            !parts[1].isEmpty, parts[1].allSatisfy(\.isNumber)
        else {
            throw .unsafeURL(key.rawValue, reason: "Invalid WWDC key")
        }
        return (year, String(parts[1]))
    }
}
