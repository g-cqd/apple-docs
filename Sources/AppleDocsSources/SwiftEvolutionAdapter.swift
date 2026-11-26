import AemiJSONCore
import AppleDocsContent
public import AppleDocsCore
import Foundation
import OrderedCollections

/// Swift Evolution proposals from `swiftlang/swift-evolution` (Bun `sources/swift-evolution.js`).
public struct SwiftEvolutionAdapter: SourceAdapter, Sendable {
    private static let owner = "swiftlang"
    private static let repo = "swift-evolution"
    private static let branch = "main"
    private static let rootSlug = "swift-evolution"

    // @dl:disable -- SourceAdapter conformance properties
    public init() {}

    public var kind: SourceKind { .swiftEvolution }
    public var displayName: String { "Swift Evolution Proposals" }

    public var defaultRoot: CorpusRootRecord {
        AdapterHelpers.collectionRoot(
            slug: Self.rootSlug,
            displayName: displayName,
            sourceType: .swiftEvolution,
            seedPath: "swift-evolution/0001-keywords-as-argument-labels"
        )
    }

    public var seedKeys: [DocumentKey] {
        AdapterHelpers.singleSeed("swift-evolution/0001-keywords-as-argument-labels")
    }

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        let filename = try AdapterHelpers.stripRootPrefix(Self.rootSlug, from: key)
        return GitHubClient.rawURL(
            owner: Self.owner,
            repo: Self.repo,
            branch: Self.branch,
            filePath: "proposals/\(filename).md"
        )
    }
    // @dl:enable

    public func discover(client: UpstreamHTTPClient, full: Bool) async throws(SourceError) -> SourceDiscovery {
        let tree = try await GitHubClient.fetchTree(
            owner: Self.owner,
            repo: Self.repo,
            branch: Self.branch,
            client: client
        )
        let keys: [DocumentKey] = tree.compactMap { entry in
            guard entry.type == "blob", entry.path.hasPrefix("proposals/"), entry.path.hasSuffix(".md") else {
                return nil
            }
            let name = String(entry.path.dropFirst("proposals/".count).dropLast(".md".count))
            return try? DocumentKey("\(Self.rootSlug)/\(name)")
        }
        return SourceDiscovery(roots: [defaultRoot], keys: keys)
    }

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let filename = try AdapterHelpers.stripRootPrefix(Self.rootSlug, from: key)
        let rawURL = try dataURL(for: key)
        return try await AdapterHelpers.fetchTransformed(
            url: rawURL,
            previousETag: previousETag,
            headers: GitHubClient.rawHeaders(),
            client: client
        ) { response in
            (Self.convertProposal(key: key, filename: filename, bytes: response.body), [])
        }
    }

    private static func convertProposal(key: DocumentKey, filename: String, bytes: [UInt8]) -> ConvertedDocument {
        let markdown = String(decoding: bytes, as: UTF8.self)
        let header = parseHeader(markdown)
        let seNumber = header.seNumber ?? fallbackSENumber(from: filename)
        let pageURL = "https://github.com/\(owner)/\(repo)/blob/\(branch)/proposals/\(filename).md"
        let base = MarkdownDocumentConverter.convert(
            markdown: bytes,
            key: key,
            sourceType: .swiftEvolution,
            fallbackTitle: filename,
            url: pageURL
        )
        var title = base.document.title
        if let seNumber, !title.contains(seNumber) {
            title = "\(seNumber): \(title)"
        }
        let metadata = JSONValue.makeObject {
            ("seNumber", header.seNumber.map(JSONValue.string) ?? .null)
            ("status", header.status.map(JSONValue.string) ?? .null)
            ("swiftVersion", header.swiftVersion.map(JSONValue.string) ?? .null)
            ("authors", header.authors.map(JSONValue.string) ?? .null)
            ("reviewManager", header.reviewManager.map(JSONValue.string) ?? .null)
        }
        let doc = DocumentRecord(
            key: key,
            sourceType: .swiftEvolution,
            title: title,
            kind: "proposal",
            role: "article",
            framework: rootSlug,
            url: pageURL,
            abstractText: base.document.abstractText,
            headings: base.document.headings,
            urlDepth: base.document.urlDepth,
            sourceMetadataJSON: JSONValue.jsonString(metadata)
        )
        return ConvertedDocument(document: doc, sections: base.sections)
    }

    private static func fallbackSENumber(from filename: String) -> String? {
        let digits = filename.prefix { $0.isNumber }
        return digits.count == 4 ? "SE-\(digits)" : nil
    }

    private struct Header {
        var seNumber: String?
        var status: String?
        var swiftVersion: String?
        var authors: String?
        var reviewManager: String?
    }

    private static func parseHeader(_ markdown: String) -> Header {
        var header = Header()
        for rawLine in markdown.split(separator: "\n", omittingEmptySubsequences: false).prefix(40) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            guard line.hasPrefix("*") || line.hasPrefix("-") else { continue }
            let rest = line.dropFirst().trimmingCharacters(in: .whitespaces)
            guard let colon = rest.firstIndex(of: ":") else { continue }
            let label = rest[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = rest[rest.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            switch label {
                case "proposal":
                    header.seNumber = extractToken(startingWith: "SE-", in: value)
                case "status":
                    header.status = value.replacing("*", with: "").trimmingCharacters(in: .whitespaces)
                    if header.swiftVersion == nil { header.swiftVersion = extractSwiftVersion(in: value) }
                case "implementation":
                    if header.swiftVersion == nil { header.swiftVersion = extractSwiftVersion(in: value) }
                case "author", "authors":
                    let names = extractBracketedNames(in: value)
                    header.authors = names.isEmpty ? stripPunctuation(value) : names.joined(separator: ", ")
                case "review manager":
                    let names = extractBracketedNames(in: value)
                    header.reviewManager = names.first ?? stripPunctuation(value)
                default:
                    break
            }
        }
        return header
    }

    private static func extractToken(startingWith prefix: String, in text: String) -> String? {
        guard let range = text.range(of: prefix, options: [.caseInsensitive]) else { return nil }
        let suffix = text[range.upperBound...].prefix { $0.isNumber }
        return suffix.isEmpty ? nil : "SE-\(suffix)"
    }

    private static func extractSwiftVersion(in text: String) -> String? {
        guard let range = text.range(of: "Swift ", options: [.caseInsensitive]) else { return nil }
        let ver = text[range.upperBound...].prefix { $0.isNumber || $0 == "." }
        let trimmed = ver.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return trimmed.contains(".") ? trimmed : nil
    }

    private static func extractBracketedNames(in text: String) -> [String] {
        var names: [String] = []
        var cursor = text.startIndex
        while cursor < text.endIndex, let open = text[cursor...].firstIndex(of: "["),
            let close = text[text.index(after: open)...].firstIndex(of: "]")
        {
            let inside = String(text[text.index(after: open) ..< close]).trimmingCharacters(in: .whitespaces)
            if !inside.isEmpty { names.append(inside) }
            cursor = text.index(after: close)
        }
        return names
    }

    private static func stripPunctuation(_ text: String) -> String {
        let drop: Set<Character> = ["[", "]", "(", ")"]
        return String(text.filter { !drop.contains($0) }).trimmingCharacters(in: .whitespaces)
    }
}
