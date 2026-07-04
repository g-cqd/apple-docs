// PackagesAdapter — the Swift Package Catalog source (port of src/sources/packages.js +
// its packages/{keys,markdown,readme}.js helpers and packages-official.js). NORMALIZE is
// pure: it decodes the fetch payload (`{ repo, readme, syncScope, fetchMode }`), uses the
// README markdown (or a synthesized stub) through the shared `MarkdownSections` parser,
// then layers the packages post-processing (title/abstract override, the `Package
// Metadata` section, the `source_metadata` JSON). The network steps run over the shared
// `GitHubClient`: `discover` enumerates the curated official allowlist (or unions it with
// the SwiftPackageIndex catalog under `full` scope); `fetch`/`check` DEFAULT to the README
// on raw.githubusercontent.com (no API quota) and OPT IN to the GitHub REST metadata path
// (stars/license/topics) when `APPLE_DOCS_PACKAGES_FETCH=api` + a token are present. No
// DocC, no BFS. A `flat` self-enumerating source.
import Foundation

public struct PackagesAdapter: SourceAdapter {
    public static let type = "packages"
    public static let displayName = "Swift Package Catalog"
    public static let syncMode = SyncMode.flat

    static let rootSlug = "packages"
    static let packageListOwner = "SwiftPackageIndex"
    static let packageListRepo = "PackageList"
    static let packageListBranch = "main"
    static let packageListPath = "packages.json"
    static let readmeFilenames = ["README.md", "readme.md", "README.markdown"]
    static let defaultBranches = ["main", "master"]

    /// The curated official allowlist (port of packages-official.js), in order.
    static let officialPackages: [(owner: String, repo: String)] = [
        ("apple", "swift-argument-parser"), ("apple", "swift-async-algorithms"),
        ("apple", "swift-algorithms"), ("apple", "swift-collections"), ("apple", "swift-numerics"),
        ("apple", "swift-atomics"), ("apple", "swift-log"), ("apple", "swift-metrics"),
        ("apple", "swift-distributed-tracing"), ("apple", "swift-crypto"),
        ("apple", "swift-certificates"), ("apple", "swift-asn1"), ("apple", "swift-nio"),
        ("apple", "swift-nio-ssl"), ("apple", "swift-nio-http2"),
        ("apple", "swift-nio-transport-services"), ("apple", "swift-http-types"),
        ("apple", "swift-system"), ("apple", "swift-docc-plugin"), ("apple", "swift-format"),
        ("apple", "swift-openapi-generator"), ("apple", "swift-openapi-runtime"),
        ("apple", "swift-foundation"),
        ("swiftlang", "swift"), ("swiftlang", "swift-syntax"), ("swiftlang", "swift-package-manager"),
        ("swiftlang", "swift-docc"), ("swiftlang", "swift-testing"), ("swiftlang", "swift-evolution"),
        ("swiftlang", "swift-markdown")
    ]

    public init() {}

    // MARK: - payload model (the JS fetch payload `{ repo, readme, syncScope, fetchMode }`)

    struct RepoPayload: Decodable, Sendable {
        struct Owner: Decodable, Sendable { let login: String? }
        struct License: Decodable, Sendable {
            let spdx_id: String?
            let name: String?
        }
        let name: String?
        let full_name: String?
        let html_url: String?
        let description: String?
        let language: String?
        let stargazers_count: Int?
        let forks_count: Int?
        let open_issues_count: Int?
        let topics: [String]?
        let homepage: String?
        let default_branch: String?
        let archived: Bool?
        let fork: Bool?
        let owner: Owner?
        let license: License?
        let pushed_at: String?
        let updated_at: String?
    }

    struct ReadmePayload: Decodable, Sendable {
        let text: String?
        let path: String?
        let htmlUrl: String?
        let downloadUrl: String?
    }

    struct PackagePayload: Decodable, Sendable {
        let repo: RepoPayload?
        let readme: ReadmePayload?
        let syncScope: String?
        let fetchMode: String?
    }

    // MARK: - normalize (pure)

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        guard case .json(let bytes) = payload else {
            throw AdapterError.unexpectedPayload("packages expects json, got \(payload)")
        }
        guard let decoded = try? JSONDecoder().decode(PackagePayload.self, from: Data(bytes)) else {
            throw AdapterError.unexpectedPayload("packages: could not decode payload for \(key)")
        }
        guard let repo = decoded.repo else {
            throw AdapterError.unexpectedPayload("packages: payload missing repository metadata for \(key)")
        }
        let readme = decoded.readme
        let scope =
            decoded.syncScope == "full"
            ? "full"
            : decoded.syncScope == "official"
                ? "official"
                : Self.packageCatalogScope()
        let fetchMode =
            decoded.fetchMode == "api"
            ? "api"
            : decoded.fetchMode == "raw"
                ? "raw"
                : Self.packageFetchMode()
        let source = fetchMode == "raw" ? "raw" : "github-api"

        let sourceMetadata = Self.sourceMetadataJSON(
            repo: repo, readme: readme, scope: scope, source: source)

        let readmeText = readme?.text
        let hasReadme = readmeText.map { !Self.jsTrim($0).isEmpty } ?? false
        let markdown = hasReadme ? readmeText! : Self.synthesizeMarkdown(repo)

        let url =
            repo.html_url
            ?? "https://github.com/\(repo.full_name ?? "\(repo.owner?.login ?? "")/\(repo.name ?? "")")"
        var page = MarkdownSections.parse(
            markdown, key: key,
            options: .init(
                sourceType: Self.type, kind: "package", framework: Self.rootSlug, url: url,
                language: Self.normalizeLanguage(repo.language), sourceMetadata: sourceMetadata))

        // `result.document.title = repo.full_name ?? repo.name ?? result.document.title`.
        page.document.title = repo.full_name ?? repo.name ?? page.document.title
        // `result.document.abstractText = repo.description?.trim() || result.document.abstractText`.
        if let description = repo.description {
            let trimmed = Self.jsTrim(description)
            if !trimmed.isEmpty { page.document.abstractText = trimmed }
        }
        page.sections = Self.ensureAbstractSection(page.sections, abstractText: page.document.abstractText)
        page.sections = Self.appendMetadataSection(page.sections, repo: repo, readme: readme)
        return page
    }

    // MARK: - discover (curated official allowlist, or the full SwiftPackageIndex catalog)

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        let root = DiscoveredRoot(
            slug: Self.rootSlug, displayName: Self.displayName, kind: "collection", source: Self.rootSlug)
        let scope = Self.packageCatalogScope()
        let limit = Self.packageSyncLimit()

        var keys: [String] = []
        var seen = Set<String>()
        func add(_ owner: String, _ repo: String) -> Bool {
            let key = Self.packageKey(owner, repo)
            if seen.insert(key).inserted { keys.append(key) }
            return limit != nil && keys.count >= limit!
        }

        for pkg in Self.officialPackages where add(pkg.owner, pkg.repo) { break }

        if scope == "full", limit == nil || keys.count < limit! {
            let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
            let raw = try await github.fetchRaw(
                owner: Self.packageListOwner, repo: Self.packageListRepo,
                branch: Self.packageListBranch, filePath: Self.packageListPath)
            guard let listData = raw.text.data(using: .utf8),
                let urls = try? JSONSerialization.jsonObject(with: listData) as? [Any]
            else {
                throw AdapterError.unexpectedPayload("packages: SwiftPackageIndex packages.json failed to parse")
            }
            for case let url as String in urls {
                if limit != nil, keys.count >= limit! { break }
                guard let parsed = Self.parsePackageUrl(url) else { continue }
                _ = add(parsed.owner, parsed.repo)
            }
        }

        return DiscoveryResult(keys: keys, roots: [root])
    }

    // MARK: - fetch (README from raw.githubusercontent.com by default; GitHub REST when `api`)

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        let (owner, repo) = try Self.parsePackageKey(key)
        let scope = Self.packageCatalogScope()
        let fetchMode = Self.packageFetchMode()
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)

        if fetchMode == "raw" {
            // No-auth path: fetch README from raw.githubusercontent.com only. Metadata
            // beyond owner/repo/description is unavailable, so the repo shape is synthesized.
            let readme = try await Self.discoverRawReadme(
                owner: owner, repo: repo, preferredBranch: "main", github)
            let branch = readme?.branch ?? "main"
            let description = Self.extractAbstractFromMarkdown(readme?.text)
            let repoJSON = Self.synthesizeRepoShape(
                owner: owner, repo: repo, branch: branch, description: description)

            let payload =
                JsJson.object([
                    ("repo", repoJSON),
                    ("readme", readme?.json ?? .null),
                    ("syncScope", .string(scope)),
                    ("fetchMode", .string("raw"))
                ])
                .serialized()
            let etag =
                JsJson.object([
                    ("source", .string("raw")),
                    ("repo", .null),
                    ("readme", (readme?.etag).map(JsJson.string) ?? .null),
                    ("branch", .string(branch)),
                    ("readmeFilename", (readme?.path).map(JsJson.string) ?? .null)
                ])
                .serialized()
            return FetchResult(
                key: key, payload: .json(Array(payload.utf8)), etag: etag, lastModified: readme?.lastModified)
        }

        // Opt-in `api` fetch-mode (richer GitHub REST metadata via the contents API) is a follow-up —
        // it needs `GitHubClient` REST methods not yet wired. `packageFetchMode()` returns "raw" without
        // a token, so this is reached only when explicitly forced; fail clearly rather than half-fetch.
        throw AdapterError.unexpectedPayload(
            "packages: api fetch-mode is not yet supported — use raw mode (unset APPLE_DOCS_PACKAGES_FETCH)")
    }

    // MARK: - check (README ETag on the raw path; repo + README ETags on the api path)

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
        -> CheckResult
    {
        let (owner, repo) = try Self.parsePackageKey(key)
        let state = Self.parseCompositeEtag(previousState)
        let branch = state.branch ?? "main"
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)

        if state.source == "raw" {
            // No-auth path: README ETag is the sole change signal.
            let readmeFilename = state.readmeFilename ?? Self.readmeFilenames[0]
            let readmeStatus = try await github.checkRaw(
                owner: owner, repo: repo, branch: branch, filePath: readmeFilename, previousEtag: state.readme)
            switch readmeStatus.status {
                case .deleted:
                    if state.readme == nil { return CheckResult(status: .unchanged, changed: false) }
                    return CheckResult(status: .modified, changed: true)
                case .modified: return CheckResult(status: .modified, changed: true)
                case .error: return CheckResult(status: .error, changed: false)
                case .unchanged: return CheckResult(status: .unchanged, changed: false)
            }
        }

        // api path is a follow-up (see fetch); force a re-fetch so the driver never skips a package.
        return CheckResult(status: .modified, changed: true)
    }

    // MARK: - source_metadata JSON (insertion-ordered, JSON.stringify byte-parity)

    static func sourceMetadataJSON(
        repo: RepoPayload, readme: ReadmePayload?, scope: String, source: String
    ) -> String {
        JsJson.object([
            ("package", .bool(true)),
            ("scope", .string(scope)),
            ("source", .string(source)),
            ("owner", (repo.owner?.login).map(JsJson.string) ?? .null),
            ("repo", repo.name.map(JsJson.string) ?? .null),
            ("fullName", repo.full_name.map(JsJson.string) ?? .null),
            ("defaultBranch", repo.default_branch.map(JsJson.string) ?? .null),
            ("stars", .int(repo.stargazers_count ?? 0)),
            ("forks", .int(repo.forks_count ?? 0)),
            ("openIssues", .int(repo.open_issues_count ?? 0)),
            ("topics", .array((repo.topics ?? []).map(JsJson.string))),
            ("archived", .bool(repo.archived ?? false)),
            ("fork", .bool(repo.fork ?? false)),
            ("homepage", repo.homepage.map(JsJson.string) ?? .null),
            ("license", normalizeLicense(repo.license).map(JsJson.string) ?? .null),
            ("primaryLanguage", normalizeLanguage(repo.language).map(JsJson.string) ?? .null),
            ("readmePath", (readme?.path).map(JsJson.string) ?? .null),
            ("readmeUrl", (readme?.htmlUrl ?? readme?.downloadUrl).map(JsJson.string) ?? .null),
            ("pushedAt", repo.pushed_at.map(JsJson.string) ?? .null),
            ("updatedAt", repo.updated_at.map(JsJson.string) ?? .null)
        ])
        .serialized()
    }

    // MARK: - markdown synthesis + section helpers (ports of packages/markdown.js)

    static func synthesizeMarkdown(_ repo: RepoPayload) -> String {
        let title = repo.full_name ?? repo.name ?? "Swift Package"
        let trimmed = repo.description.map(jsTrim) ?? ""
        let description = trimmed.isEmpty ? "Package metadata imported from GitHub." : trimmed
        return "# \(title)\n\n\(description)\n"
    }

    static func normalizeLicense(_ license: RepoPayload.License?) -> String? {
        guard let license else { return nil }
        if let spdx = license.spdx_id, !spdx.isEmpty, spdx != "NOASSERTION" { return spdx }
        return license.name
    }

    static func normalizeLanguage(_ language: String?) -> String? {
        guard let language else { return nil }
        let trimmed = jsTrim(language)
        return trimmed.isEmpty ? nil : trimmed.lowercased()
    }

    /// Reassign each section's `sortOrder` to its index (JS `reindexSections`).
    static func reindex(_ sections: [NormalizedSection]) -> [NormalizedSection] {
        sections.enumerated()
            .map { index, section in
                var copy = section
                copy.sortOrder = index
                return copy
            }
    }

    static func ensureAbstractSection(_ sections: [NormalizedSection], abstractText: String?)
        -> [NormalizedSection]
    {
        guard let abstractText, !abstractText.isEmpty else { return sections }
        var next = sections
        if let index = next.firstIndex(where: { $0.sectionKind == "abstract" }) {
            next[index].contentText = abstractText
            next[index].contentJson = nil
        } else {
            next.insert(
                NormalizedSection(
                    sectionKind: "abstract", heading: nil, contentText: abstractText, contentJson: nil,
                    sortOrder: 0), at: 0)
        }
        return reindex(next)
    }

    static func appendMetadataSection(
        _ sections: [NormalizedSection], repo: RepoPayload, readme: ReadmePayload?
    ) -> [NormalizedSection] {
        var fields: [String] = []
        fields.append("Repository: \(repo.full_name ?? repo.name ?? "unknown")")
        if let homepage = repo.homepage, !homepage.isEmpty { fields.append("Homepage: \(homepage)") }
        if let stars = repo.stargazers_count { fields.append("Stars: \(stars)") }
        if let forks = repo.forks_count { fields.append("Forks: \(forks)") }
        if let openIssues = repo.open_issues_count { fields.append("Open issues: \(openIssues)") }
        if let branch = repo.default_branch, !branch.isEmpty { fields.append("Default branch: \(branch)") }
        if let language = normalizeLanguage(repo.language) { fields.append("Primary language: \(language)") }
        if let license = normalizeLicense(repo.license) { fields.append("License: \(license)") }
        if let topics = repo.topics, !topics.isEmpty {
            fields.append("Topics: \(topics.joined(separator: ", "))")
        }
        if let path = readme?.path, !path.isEmpty { fields.append("README: \(path)") }
        if repo.archived == true { fields.append("Archived: yes") }
        if repo.fork == true { fields.append("Fork: yes") }
        if fields.isEmpty { return sections }

        return reindex(
            sections + [
                NormalizedSection(
                    sectionKind: "discussion", heading: "Package Metadata",
                    contentText: fields.joined(separator: "\n\n"), contentJson: nil,
                    sortOrder: sections.count)
            ])
    }

    /// The GitHub-`/readme`-shaped repo synthesized for the raw path (port of synthesizeRepoShape).
    static func synthesizeRepoShape(owner: String, repo: String, branch: String, description: String?)
        -> JsJson
    {
        .object([
            ("name", .string(repo)),
            ("full_name", .string("\(owner)/\(repo)")),
            ("html_url", .string("https://github.com/\(owner)/\(repo)")),
            ("description", description.map(JsJson.string) ?? .null),
            ("language", .null),
            ("stargazers_count", .null),
            ("forks_count", .null),
            ("open_issues_count", .null),
            ("topics", .array([])),
            ("homepage", .null),
            ("default_branch", .string(branch)),
            ("archived", .bool(false)),
            ("fork", .bool(false)),
            ("owner", .object([("login", .string(owner))])),
            ("license", .null),
            ("pushed_at", .null),
            ("updated_at", .null)
        ])
    }

    /// A GitHub-`/repos/{owner}/{repo}`-shaped object rebuilt from a decoded `RepoPayload`
    /// (the api path re-serializes the fetched repo into the fetch payload; only the fields
    /// `normalize` reads are carried, each preserving its present/absent optionality).
    static func repoJson(_ repo: RepoPayload) -> JsJson {
        .object([
            ("name", repo.name.map(JsJson.string) ?? .null),
            ("full_name", repo.full_name.map(JsJson.string) ?? .null),
            ("html_url", repo.html_url.map(JsJson.string) ?? .null),
            ("description", repo.description.map(JsJson.string) ?? .null),
            ("language", repo.language.map(JsJson.string) ?? .null),
            ("stargazers_count", repo.stargazers_count.map(JsJson.int) ?? .null),
            ("forks_count", repo.forks_count.map(JsJson.int) ?? .null),
            ("open_issues_count", repo.open_issues_count.map(JsJson.int) ?? .null),
            ("topics", .array((repo.topics ?? []).map(JsJson.string))),
            ("homepage", repo.homepage.map(JsJson.string) ?? .null),
            ("default_branch", repo.default_branch.map(JsJson.string) ?? .null),
            ("archived", repo.archived.map(JsJson.bool) ?? .null),
            ("fork", repo.fork.map(JsJson.bool) ?? .null),
            ("owner", (repo.owner?.login).map { JsJson.object([("login", .string($0))]) } ?? .null),
            ("license", licenseJson(repo.license)),
            ("pushed_at", repo.pushed_at.map(JsJson.string) ?? .null),
            ("updated_at", repo.updated_at.map(JsJson.string) ?? .null)
        ])
    }

    static func licenseJson(_ license: RepoPayload.License?) -> JsJson {
        guard let license else { return .null }
        return .object([
            ("spdx_id", license.spdx_id.map(JsJson.string) ?? .null),
            ("name", license.name.map(JsJson.string) ?? .null)
        ])
    }

    // MARK: - README discovery (raw.githubusercontent.com; ports of packages/readme.js)

    /// A discovered README plus its validators + branch (the JS readme payload shape).
    struct DiscoveredReadme: Sendable {
        let text: String
        let path: String
        let htmlUrl: String
        let downloadUrl: String
        let etag: String?
        let lastModified: String?
        let branch: String

        /// The readme object embedded in the fetch payload (JSON.stringify parity for fetch).
        var json: JsJson {
            .object([
                ("text", .string(text)),
                ("path", .string(path)),
                ("sha", .null),
                ("htmlUrl", .string(htmlUrl)),
                ("downloadUrl", .string(downloadUrl)),
                ("etag", etag.map(JsJson.string) ?? .null),
                ("lastModified", lastModified.map(JsJson.string) ?? .null),
                ("branch", .string(branch))
            ])
        }
    }

    /// Try README filename variants on a branch, first 200 wins; nil if all 404 (port of
    /// fetchRawReadmeOnBranch, over the GitHubClient whose fetchRaw throws `.notFound` on 404).
    static func fetchRawReadmeOnBranch(owner: String, repo: String, branch: String, _ github: GitHubClient)
        async throws -> DiscoveredReadme?
    {
        for filename in readmeFilenames {
            do {
                let raw = try await github.fetchRaw(
                    owner: owner, repo: repo, branch: branch, filePath: filename)
                return DiscoveredReadme(
                    text: raw.text, path: filename,
                    htmlUrl: "https://github.com/\(owner)/\(repo)/blob/\(branch)/\(filename)",
                    downloadUrl: "https://raw.githubusercontent.com/\(owner)/\(repo)/\(branch)/\(filename)",
                    etag: raw.etag, lastModified: raw.lastModified, branch: branch)
            } catch GitHubClient.GitHubError.notFound {
                continue
            }
        }
        return nil
    }

    /// Look up a README across preferred + default branches × filename variants (discoverRawReadme).
    static func discoverRawReadme(owner: String, repo: String, preferredBranch: String?, _ github: GitHubClient)
        async throws -> DiscoveredReadme?
    {
        var branches: [String] = []
        if let preferredBranch { branches.append(preferredBranch) }
        for branch in defaultBranches where !branches.contains(branch) { branches.append(branch) }
        for branch in branches {
            if let readme = try await fetchRawReadmeOnBranch(owner: owner, repo: repo, branch: branch, github) {
                return readme
            }
        }
        return nil
    }

    /// The first prose paragraph after the H1 (port of extractAbstractFromMarkdown): skip badges
    /// and HTML-only lines, collapse whitespace, cap at 280 chars.
    static func extractAbstractFromMarkdown(_ markdown: String?) -> String? {
        guard let markdown, !markdown.isEmpty else { return nil }
        let lines = markdown.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r" })
        var seenH1 = false
        for rawLine in lines {
            let line = jsTrim(String(rawLine))
            if line.isEmpty { continue }
            if !seenH1 {
                if line.hasPrefix("# ") {
                    seenH1 = true
                    continue
                }
                if !line.hasPrefix("<") && !line.hasPrefix("[![") && !line.hasPrefix("![") {
                    return collapseAndCap(line)
                }
                continue
            }
            if line.hasPrefix("#") { continue }
            if line.hasPrefix("<") || line.hasPrefix("[![") || line.hasPrefix("![") { continue }
            return collapseAndCap(line)
        }
        return nil
    }

    /// `line.replace(/\s+/g, ' ').slice(0, 280)` — JS String.slice counts UTF-16 code units.
    private static func collapseAndCap(_ line: String) -> String {
        let collapsed = line.replacingOccurrences(
            of: #"\s+"#, with: " ", options: .regularExpression)
        let units = Array(collapsed.utf16)
        guard units.count > 280 else { return collapsed }
        return String(utf16CodeUnits: Array(units.prefix(280)), count: 280)
    }

    // MARK: - composite key/etag helpers (ports of packages/keys.js)

    /// `packages/<owner.lowercased()>/<repo.lowercased()>`.
    static func packageKey(_ owner: String, _ repo: String) -> String {
        "\(rootSlug)/\(owner.lowercased())/\(repo.lowercased())"
    }

    /// `packages/<owner>/<repo>` → (owner, repo), throwing on a malformed key.
    static func parsePackageKey(_ key: String) throws -> (owner: String, repo: String) {
        let parts = key.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == rootSlug, !parts[1].isEmpty, !parts[2].isEmpty else {
            throw AdapterError.unexpectedPayload("packages: invalid package key '\(key)'")
        }
        return (String(parts[1]), String(parts[2]))
    }

    /// `https://github.com/<owner>/<repo>(.git)?/?` → (owner, repo), decoded; nil otherwise.
    static func parsePackageUrl(_ url: String) -> (owner: String, repo: String)? {
        let trimmed = jsTrim(url)
        let pattern = #"^https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let nsText = trimmed as NSString
        guard let match = regex.firstMatch(in: trimmed, range: NSRange(location: 0, length: nsText.length)),
            match.numberOfRanges > 2
        else { return nil }
        let owner =
            nsText.substring(with: match.range(at: 1)).removingPercentEncoding
            ?? nsText.substring(with: match.range(at: 1))
        let repo =
            nsText.substring(with: match.range(at: 2)).removingPercentEncoding
            ?? nsText.substring(with: match.range(at: 2))
        return (owner, repo)
    }

    /// The parsed composite ETag (source/repo/readme/branch/readmeFilename); JS `parseCompositeEtag`.
    struct CompositeEtag: Sendable {
        var source: String
        var repo: String?
        var readme: String?
        var branch: String?
        var readmeFilename: String?
    }

    static func parseCompositeEtag(_ value: String?) -> CompositeEtag {
        guard let value, !value.isEmpty else {
            return CompositeEtag(source: "api", repo: nil, readme: nil, branch: nil, readmeFilename: nil)
        }
        guard let data = value.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            // A bare (non-JSON) validator is treated as the repo ETag under `api`.
            return CompositeEtag(source: "api", repo: value, readme: nil, branch: nil, readmeFilename: nil)
        }
        let source = (object["source"] as? String) == "raw" ? "raw" : "api"
        return CompositeEtag(
            source: source, repo: object["repo"] as? String, readme: object["readme"] as? String,
            branch: object["branch"] as? String, readmeFilename: object["readmeFilename"] as? String)
    }

    // MARK: - run-scope resolution (env-driven; JS packageCatalogScope/FetchMode/SyncLimit)

    static func packageCatalogScope() -> String {
        let raw = (ProcessInfo.processInfo.environment["APPLE_DOCS_PACKAGES_SCOPE"] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if raw == "full" { return "full" }
        if raw == "official" { return "official" }
        return "official"
    }

    static func packageFetchMode() -> String {
        let override = (ProcessInfo.processInfo.environment["APPLE_DOCS_PACKAGES_FETCH"] ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if override == "raw" { return "raw" }
        if override == "api" { return GitHubClient.tokenFromEnvironment() != nil ? "api" : "raw" }
        return "raw"
    }

    static func packageSyncLimit() -> Int? {
        guard let raw = ProcessInfo.processInfo.environment["APPLE_DOCS_PACKAGES_LIMIT"], !raw.isEmpty
        else { return nil }
        guard let parsed = jsParseInt(raw), parsed > 0 else { return nil }
        return parsed
    }

    // MARK: - JS string primitives

    /// ECMAScript `String.prototype.trim` over the whitespace + line-terminator set.
    static func jsTrim(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `Number.parseInt(raw, 10)` — leading optional sign + decimal digits, ignore the rest.
    private static func jsParseInt(_ raw: String) -> Int? {
        var scalars = Substring(raw.drop(while: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" }))
        var sign = 1
        if let first = scalars.first, first == "+" || first == "-" {
            if first == "-" { sign = -1 }
            scalars = scalars.dropFirst()
        }
        let digits = scalars.prefix(while: { $0.isNumber && $0.isASCII })
        guard let magnitude = Int(digits) else { return nil }
        return sign * magnitude
    }
}
