// SwiftEvolutionAdapter — the Swift Evolution proposals source (port of
// src/sources/swift-evolution.js). The NORMALIZE path is fully native + pure (parse
// the proposal's metadata header, then MarkdownSections for the body), demonstrating
// the adapter stack end-to-end. The network steps (discover/fetch/check) run over the
// shared `GitHubClient` (recursive tree → keys; raw fetch; conditional-GET check).
import Foundation

/// Shared adapter faults.
public enum AdapterError: Error, Sendable, Equatable {
    /// A step that depends on a not-yet-built foundation (e.g. the GitHub client).
    case notImplemented(String)
    /// `normalize` received a payload shape it doesn't handle.
    case unexpectedPayload(String)
}

public struct SwiftEvolutionAdapter: SourceAdapter {
    public static let type = "swift-evolution"
    public static let displayName = "Swift Evolution Proposals"
    public static let syncMode = SyncMode.manual

    static let owner = "swiftlang"
    static let repo = "swift-evolution"
    static let branch = "main"
    static let rootSlug = "swift-evolution"

    public init() {}

    // MARK: - normalize (pure)

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        guard case .markdown(let markdown) = payload else {
            throw AdapterError.unexpectedPayload("swift-evolution expects markdown, got \(payload)")
        }
        let header = Self.parseProposalHeader(markdown)
        let filename = Self.filename(forKey: key)
        let seNumber = header.seNumber ?? key.split(separator: "/").last.map { $0.uppercased() }
        let url =
            "https://github.com/\(Self.owner)/\(Self.repo)/blob/\(Self.branch)/proposals/\(filename).md"

        var page = MarkdownSections.parse(
            markdown, key: key,
            options: .init(
                sourceType: Self.type, kind: "proposal", framework: Self.rootSlug, url: url,
                sourceMetadata: header.json))

        // Prefix the title with the SE number when it isn't already present.
        if let title = page.document.title, let seNumber, !title.contains(seNumber) {
            page.document.title = "\(seNumber): \(title)"
        }
        return page
    }

    // MARK: - network (over the shared GitHubClient)

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
        let tree = try await github.fetchTree(owner: Self.owner, repo: Self.repo, branch: Self.branch)
        let keys = tree
            .filter { $0.type == "blob" && $0.path.hasPrefix("proposals/") && $0.path.hasSuffix(".md") }
            .map { entry -> String in
                let filename = entry.path.dropFirst("proposals/".count).dropLast(".md".count)
                return "\(Self.rootSlug)/\(filename)"
            }
        let root = DiscoveredRoot(
            slug: Self.rootSlug, displayName: Self.displayName, kind: "collection", source: Self.rootSlug)
        return DiscoveryResult(keys: keys, roots: [root])
    }

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
        let raw = try await github.fetchRaw(
            owner: Self.owner, repo: Self.repo, branch: Self.branch,
            filePath: "proposals/\(Self.filename(forKey: key)).md")
        return FetchResult(key: key, payload: .markdown(raw.text), etag: raw.etag, lastModified: raw.lastModified)
    }

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws -> CheckResult {
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
        return try await github.checkRaw(
            owner: Self.owner, repo: Self.repo, branch: Self.branch,
            filePath: "proposals/\(Self.filename(forKey: key)).md", previousEtag: previousState)
    }

    // MARK: - helpers

    /// The proposals filename for a key (`swift-evolution/0001-foo` → `0001-foo`).
    static func filename(forKey key: String) -> String {
        let prefix = "\(rootSlug)/"
        return key.hasPrefix(prefix) ? String(key.dropFirst(prefix.count)) : key
    }

    /// The structured header of a Swift Evolution proposal (SE number, status, Swift
    /// version, authors, review manager) — the port of `parseProposalHeader`.
    struct ProposalHeader: Sendable, Equatable {
        var seNumber: String?
        var status: String?
        var swiftVersion: String?
        var authors: String?
        var reviewManager: String?

        /// `JSON.stringify(header)` equivalent (sorted keys; nulls kept).
        var json: String {
            let object: [String: Any] = [
                "seNumber": seNumber ?? NSNull(), "status": status ?? NSNull(),
                "swiftVersion": swiftVersion ?? NSNull(), "authors": authors ?? NSNull(),
                "reviewManager": reviewManager ?? NSNull(),
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
                let string = String(data: data, encoding: .utf8)
            else { return "{}" }
            return string
        }
    }

    static func parseProposalHeader(_ markdown: String) -> ProposalHeader {
        var header = ProposalHeader()

        // SE number: `* Proposal: [SE-NNNN]` or `* Proposal: SE-NNNN`.
        header.seNumber = firstGroup(
            #"\*\s*Proposal:\s*\[?(SE-\d+)\]?"#, markdown, options: [.caseInsensitive])

        // Status: `* Status: **Accepted**` → strip the `*` emphasis.
        if let status = firstGroup(
            #"\*\s*Status:\s*\*{0,2}(.+?)\*{0,2}\s*$"#, markdown, options: [.anchorsMatchLines])
        {
            header.status = trimmed(status.replacingOccurrences(of: "*", with: ""))
        }

        // Swift version: `Swift X.Y(.Z)`.
        header.swiftVersion = firstGroup(
            #"Swift\s+(\d+\.\d+(?:\.\d+)?)"#, markdown, options: [.caseInsensitive])

        // Authors: `* Authors: [Name](url), [Name2](url)` → joined names, or the raw text.
        if let authorsLine = firstGroup(#"\*\s*Authors?:\s*(.+)$"#, markdown, options: [.anchorsMatchLines]) {
            let names = allGroups(#"\[([^\]]+)\]"#, authorsLine)
            header.authors =
                names.isEmpty
                ? trimmed(authorsLine.replacingOccurrences(of: #"[\[\]()]"#, with: "", options: .regularExpression))
                : names.joined(separator: ", ")
        }

        // Review Manager: the linked name, else the raw text.
        if let rmLine = firstGroup(#"\*\s*Review Manager:\s*(.+)$"#, markdown, options: [.anchorsMatchLines]) {
            header.reviewManager = firstGroup(#"\[([^\]]+)\]"#, rmLine) ?? trimmed(rmLine)
        }

        return header
    }

    // MARK: - regex utilities (NSRegularExpression over UTF-16, matching JS semantics)

    private static func firstGroup(
        _ pattern: String, _ text: String, options: NSRegularExpression.Options = []
    ) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
        let nsText = text as NSString
        guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: nsText.length)),
            match.numberOfRanges > 1
        else { return nil }
        let range = match.range(at: 1)
        return range.location == NSNotFound ? nil : nsText.substring(with: range)
    }

    private static func allGroups(_ pattern: String, _ text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let nsText = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: nsText.length)).compactMap {
            $0.numberOfRanges > 1 && $0.range(at: 1).location != NSNotFound
                ? nsText.substring(with: $0.range(at: 1)) : nil
        }
    }

    private static func trimmed(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
