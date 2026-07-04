// SwiftBookAdapter — The Swift Programming Language source (port of
// src/sources/swift-book.js). The first STATEFUL adapter: `discover` builds a chapter
// index (chapter basename → full key) that `normalize` reads to resolve the root TOC's
// `<doc:Chapter>` references into child relationships — so the registry vends a FRESH
// instance per crawl (see SourceAdapter.init). Reuses MarkdownSections (body),
// DocCMarkdown (Topics curation), and GitHubClient (network).
//
// A `final class` (carries mutable `chapterIndex` across discover→normalize on one
// instance) marked `@unchecked Sendable`: the pipeline drives a single instance
// sequentially (discover, then normalize per key), never concurrently.
import Foundation

public final class SwiftBookAdapter: SourceAdapter, @unchecked Sendable {
    public static let type = "swift-book"
    public static let displayName = "The Swift Programming Language"
    public static let syncMode = SyncMode.flat

    /// The JS `static entryPoints` — TSPL's cross-source entry point (consumed
    /// by swift-org's "Related Documentation" via the EntryPointRegistry).
    public static let entryPoints = [
        EntryPoint(
            slug: rootSlug,
            key: "\(rootSlug)/\(rootFile)",
            title: "The Swift Programming Language",
            summary: "The canonical Swift language guide and reference manual.",
            parents: ["swift-org/documentation", "swift-org/documentation/tspl"])
    ]

    static let owner = "swiftlang"
    static let repo = "swift-book"
    static let branch = "main"
    static let rootSlug = "swift-book"
    static let contentPrefix = "TSPL.docc/"
    static let rootFile = "The-Swift-Programming-Language"

    /// chapter basename (lowercased) → full storage key; built by `discover`.
    private var chapterIndex: [String: String] = [:]

    public init() {}

    // MARK: - network (over GitHubClient)

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
        let tree = try await github.fetchTree(owner: Self.owner, repo: Self.repo, branch: Self.branch)
        let keys =
            tree
            .filter {
                $0.type == "blob" && $0.path.hasPrefix(Self.contentPrefix) && $0.path.hasSuffix(".md")
                    && !$0.path.contains("/Snippets/")
            }
            .map { entry -> String in
                let relative = entry.path.dropFirst(Self.contentPrefix.count).dropLast(".md".count)
                return "\(Self.rootSlug)/\(relative)"
            }
        chapterIndex = Self.buildChapterIndex(keys)
        let root = DiscoveredRoot(
            slug: Self.rootSlug, displayName: Self.displayName, kind: "collection", source: Self.rootSlug)
        return DiscoveryResult(keys: keys, roots: [root])
    }

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
        let raw = try await github.fetchRaw(
            owner: Self.owner, repo: Self.repo, branch: Self.branch,
            filePath: "\(Self.contentPrefix)\(Self.relativePath(forKey: key)).md")
        return FetchResult(key: key, payload: .markdown(raw.text), etag: raw.etag, lastModified: raw.lastModified)
    }

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws -> CheckResult {
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
        return try await github.checkRaw(
            owner: Self.owner, repo: Self.repo, branch: Self.branch,
            filePath: "\(Self.contentPrefix)\(Self.relativePath(forKey: key)).md", previousEtag: previousState)
    }

    // MARK: - normalize

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        guard case .markdown(let markdown) = payload else {
            throw AdapterError.unexpectedPayload("swift-book expects markdown, got \(payload)")
        }
        let filename = key.split(separator: "/").last.map(String.init) ?? ""
        let isRoot = filename == Self.rootFile
        let tail = "documentation/the-swift-programming-language/"
        let url =
            isRoot
            ? "https://docs.swift.org/swift-book/\(tail)"
            : "https://docs.swift.org/swift-book/\(tail)\(filename.lowercased())"

        var page = MarkdownSections.parse(
            markdown, key: key,
            options: .init(
                sourceType: Self.type, kind: isRoot ? "collection" : "book-chapter",
                framework: Self.rootSlug, url: url))
        if page.document.title == nil { page.document.title = Self.humanize(filename) }

        if isRoot {
            applyRootTopics(&page, markdown: markdown, rootKey: key)
        } else {
            applyChapterMetadata(&page, key: key)
        }
        return page
    }

    // MARK: - root TOC topics + child relationships

    private func applyRootTopics(_ page: inout NormalizedPage, markdown: String, rootKey: String) {
        let groups = DocCMarkdown.parseTopics(markdown)
        guard !groups.isEmpty else { return }

        // Replace the auto-extracted "Topics" discussion with a structured topics section.
        page.sections.removeAll { $0.sectionKind == "discussion" && $0.heading == "Topics" }
        let order = (page.sections.map(\.sortOrder).max() ?? -1) + 1

        let linkSections: [[String: Any]] = groups.map { group in
            [
                "title": group.title, "type": NSNull(),
                "items": group.items.map { chapter -> [String: Any] in
                    [
                        "identifier": "swift-book://\(chapter)",
                        "key": chapterIndex[chapter.lowercased()] ?? NSNull(),
                        "title": Self.humanize(chapter)
                    ]
                }
            ]
        }
        let contentText =
            groups
            .map { group in ([group.title] + group.items.map { Self.humanize($0) }).joined(separator: "\n") }
            .joined(separator: "\n")

        page.sections.append(
            NormalizedSection(
                sectionKind: "topics", heading: "Topics",
                contentText: contentText.isEmpty ? nil : contentText,
                contentJson: Self.jsonString(linkSections), sortOrder: order))

        var relationshipOrder = 0
        for group in groups {
            for chapter in group.items {
                guard let toKey = chapterIndex[chapter.lowercased()] else { continue }
                page.relationships.append(
                    NormalizedRelationship(
                        fromKey: rootKey, toKey: toKey, relationType: "child", section: group.title,
                        sortOrder: relationshipOrder))
                relationshipOrder += 1
            }
        }
    }

    /// Tag a chapter page with its TSPL section group (from the directory).
    private func applyChapterMetadata(_ page: inout NormalizedPage, key: String) {
        let path = Self.relativePath(forKey: key)
        guard path.contains("/"), let dir = path.split(separator: "/").first.map(String.init),
            let sectionTitle = Self.bookSectionTitles[dir]
        else { return }
        page.document.sourceMetadata = Self.jsonString([
            "bookSection": sectionTitle, "bookSectionDir": dir
        ])
    }

    // MARK: - helpers

    static let bookSectionTitles = [
        "GuidedTour": "Welcome to Swift", "LanguageGuide": "Language Guide",
        "ReferenceManual": "Language Reference", "RevisionHistory": "Revision History"
    ]

    /// The repo-relative path for a key (`swift-book/LanguageGuide/TheBasics` →
    /// `LanguageGuide/TheBasics`).
    static func relativePath(forKey key: String) -> String {
        let prefix = "\(rootSlug)/"
        return key.hasPrefix(prefix) ? String(key.dropFirst(prefix.count)) : key
    }

    /// chapter basename (lowercased) → full key, skipping the root file.
    static func buildChapterIndex(_ keys: [String]) -> [String: String] {
        var index: [String: String] = [:]
        for key in keys {
            let path = relativePath(forKey: key)
            guard let filename = path.split(separator: "/").last.map(String.init),
                filename != rootFile
            else { continue }
            index[filename.lowercased()] = key
        }
        return index
    }

    /// `humanizeFilename`: strip `.md`, then split camelCase into words.
    static func humanize(_ filename: String) -> String {
        var text = filename.hasSuffix(".md") ? String(filename.dropLast(3)) : filename
        text = replace(#"([a-z])([A-Z])"#, in: text, with: "$1 $2")
        text = replace(#"([A-Z]+)([A-Z][a-z])"#, in: text, with: "$1 $2")
        return text
    }

    private static func replace(_ pattern: String, in text: String, with template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let range = NSRange(location: 0, length: (text as NSString).length)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: template)
    }

    private static func jsonString(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
            let string = String(data: data, encoding: .utf8)
        else { return "null" }
        return string
    }
}
