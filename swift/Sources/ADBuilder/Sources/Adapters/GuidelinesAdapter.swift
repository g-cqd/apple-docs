// GuidelinesAdapter — the App Store Review Guidelines source (port of
// src/sources/guidelines.js + content/normalize/guidelines.js). ONE upstream
// HTML page parses into per-section documents (GuidelinesParser).
//
// NATIVE DISCOVERY DEVIATION (documented): the JS discovers only the ROOT key
// and reaches the per-section keys through the pipeline's extractReferences
// follow (each child key then re-GETs the same page). The native CrawlDriver
// has no reference-following yet, so `discover` fetches + parses the page
// ONCE and returns the root key PLUS every section path; `fetch` serves
// sections from the instance cache (one GET total). The PERSISTED rows —
// documents/sections/relationships — are identical to the JS crawl's; only
// the request pattern differs (fewer GETs).

import Foundation
import HTTPTypes
import HTTPTypesFoundation

public final class GuidelinesAdapter: SourceAdapter, @unchecked Sendable {
    public static let type = "guidelines"
    public static let displayName = "App Store Review Guidelines"
    public static let syncMode = SyncMode.snapshot

    static let rootSlug = GuidelinesParser.rootSlug
    static let userAgent = "apple-docs/2.0"
    static let bodyLimit = 16 << 20

    /// Parsed once per instance (discover or first fetch).
    private var parsed: GuidelinesParser.ParseResult?
    private var pageEtag: String?
    private var pageLastModified: String?

    public init() {}

    // MARK: - discover

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        let result = try await loadParsed(context)
        let root = DiscoveredRoot(
            slug: Self.rootSlug, displayName: Self.displayName, kind: "guidelines",
            source: "html-scrape")
        return DiscoveryResult(
            keys: [Self.rootSlug] + result.sections.map(\.path), roots: [root])
    }

    // MARK: - fetch (from the one-page cache)

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        _ = try await loadParsed(context)
        // The payload is only a correlation handle — normalize reads the parsed
        // section off the instance (the JS ships the parsed section object in
        // its loose payload; the closed SourcePayload can't, and doesn't need to).
        return FetchResult(
            key: key, payload: .markdown(key), etag: pageEtag, lastModified: pageLastModified)
    }

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
        -> CheckResult
    {
        try await context.rateLimiter.acquire()
        guard let url = URL(string: GuidelinesParser.guidelinesURL) else {
            return CheckResult(status: .error, changed: false)
        }
        var head = HTTPRequest(url: url)
        head.method = .head
        head.headerFields[.userAgent] = Self.userAgent
        if let previousState { head.headerFields[.ifNoneMatch] = previousState }
        do {
            let response = try await context.client.send(HTTPClientRequest(head, deadline: .seconds(30)))
            switch response.status.code {
                case 304: return CheckResult(status: .unchanged, changed: false, newState: previousState)
                case 404: return CheckResult(status: .deleted, changed: false, deleted: true)
                case 200 ..< 300: return CheckResult(status: .modified, changed: true, newState: response.etag)
                default: return CheckResult(status: .error, changed: false)
            }
        } catch {
            return CheckResult(status: .error, changed: false)
        }
    }

    // MARK: - normalize (normalizeGuidelines port)

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        // The ROOT key normalizes with NO section (the JS root-payload path:
        // every field reads undefined ⇒ the nil branches below).
        let section = key == Self.rootSlug ? nil : parsed?.sections.first { $0.path == key }
        return Self.normalizeGuidelines(section, key: key)
    }

    /// Port of `normalizeGuidelines(payload, key)` over a parsed section (nil
    /// reproduces the JS root case where the raw payload has none of the
    /// section fields).
    static func normalizeGuidelines(_ section: GuidelinesParser.Section?, key: String)
        -> NormalizedPage
    {
        let title = section?.title
        let role = section?.role
        let roleHeading = section?.roleHeading
        let path = section?.path ?? key

        // `https://developer.apple.com/app-store/review/guidelines/#<id ?? ''>`.
        let url = "\(GuidelinesParser.guidelinesURL)#\(section?.id ?? "")"

        var sections: [NormalizedSection] = []
        var order = 0
        if let abstract = section?.abstract, !abstract.isEmpty {
            sections.append(
                NormalizedSection(
                    sectionKind: "abstract", heading: nil, contentText: abstract, contentJson: nil,
                    sortOrder: order))
            order += 1
        }
        if let markdown = section?.markdown, !markdown.isEmpty {
            sections.append(
                NormalizedSection(
                    sectionKind: "discussion", heading: "Overview", contentText: markdown,
                    contentJson: nil, sortOrder: order))
            order += 1
        }

        var relationships: [NormalizedRelationship] = []
        for (index, childPath) in (section?.children ?? []).enumerated() where !childPath.isEmpty {
            relationships.append(
                NormalizedRelationship(
                    fromKey: key, toKey: childPath, relationType: "child", section: "Topics",
                    sortOrder: index))
        }

        return NormalizedPage(
            document: NormalizedDocument(
                sourceType: type, key: key, title: title, kind: role ?? "article", role: role,
                roleHeading: roleHeading, framework: rootSlug, url: url, language: nil,
                abstractText: (section?.abstract).flatMap { $0.isEmpty ? nil : $0 },
                declarationText: nil, platformsJson: nil, minIos: nil, minMacos: nil,
                minWatchos: nil, minTvos: nil, minVisionos: nil, isDeprecated: false, isBeta: false,
                isReleaseNotes: false,
                urlDepth: path.split(separator: "/", omittingEmptySubsequences: false).count - 1,
                headings: nil, sourceMetadata: nil),
            sections: sections, relationships: relationships)
    }

    public func extractReferences(_ key: String, _ payload: SourcePayload) -> [String] {
        guard key != Self.rootSlug else { return [] }
        return parsed?.sections.first { $0.path == key }?.children ?? []
    }

    // MARK: - the one-page load

    private func loadParsed(_ context: SourceContext) async throws -> GuidelinesParser.ParseResult {
        if let parsed { return parsed }
        guard let url = URL(string: GuidelinesParser.guidelinesURL) else {
            throw AdapterError.unexpectedPayload("guidelines: malformed URL")
        }
        var get = HTTPRequest(url: url)
        get.method = .get
        get.headerFields[.userAgent] = Self.userAgent
        let response = try await RetryPolicy.fetchWithRetry(
            HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
            rateLimiter: context.rateLimiter)
        let bytes = try await response.body.collect(upTo: Self.bodyLimit)
        let result = try GuidelinesParser.parse(String(decoding: bytes, as: UTF8.self))
        parsed = result
        pageEtag = response.etag
        pageLastModified = response.lastModified
        return result
    }
}
