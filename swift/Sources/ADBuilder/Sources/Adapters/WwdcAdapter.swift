// WwdcAdapter — the WWDC Sessions source (port of src/sources/wwdc.js +
// wwdc/{constants,apple-html,transcript}.js). ONE adapter, TWO corpora:
//
//   - Apple developer.apple.com video pages (year >= 2020): the year-index page
//     is scraped for session IDs + a sessionId→track map, and each session's
//     play page is scraped (regex over the HTML) into a structured payload.
//   - ASCIIwwdc community transcripts (1997–2019): raw `.vtt` files discovered by
//     walking a GitHub repo's git tree and fetched over the shared GitHubClient.
//
// A `final class` (`@unchecked Sendable`): `discover` builds a per-year track cache
// that `fetch` reads (the JS `#tracksByYear` memo — tracks live only on the year
// index, not on the per-session play pages), so the registry vends a FRESH instance
// per crawl. The cache is guarded by a lock (the flat pipeline fetches concurrently).
//
// The Apple HTML scrape produces a flat JSON payload carried through `.json`, so
// `normalize` stays a pure `(key, payload) → NormalizedPage`. Regexes run over
// `NSString` (UTF-16), matching JS string offsets/`.length` for byte parity.
import Foundation
import HTTPTypes
import HTTPTypesFoundation

public final class WwdcAdapter: SourceAdapter, @unchecked Sendable {
    public static let type = "wwdc"
    public static let displayName = "WWDC Sessions"
    public static let syncMode = SyncMode.flat

    // MARK: - constants (wwdc/constants.js)

    static let rootSlug = "wwdc"
    static let appleVideosIndex = "https://developer.apple.com/videos"
    static let appleBase = "https://developer.apple.com/videos/play"
    static let asciiwwdcOwner = "ASCIIwwdc"
    static let asciiwwdcRepo = "wwdc-session-transcripts"
    static let asciiwwdcBranch = "master"
    static let asciiwwdcLanguage = "en"
    static let userAgent = "apple-docs/2.0"
    static let bodyLimit = 16 << 20
    static let asciiwwdcYearMin = 1997
    static let asciiwwdcYearMax = 2019

    /// `VTT_TIMESTAMP_RE` — a WEBVTT cue-timing line.
    static let vttTimestampRegex = try? NSRegularExpression(
        pattern: "^(?:\\d{2}:)?\\d{2}:\\d{2}\\.\\d{3}\\s+-->\\s+(?:\\d{2}:)?\\d{2}:\\d{2}\\.\\d{3}(?:\\s+.*)?$")

    /// Years served by Apple's video pages (2020 → the current year), the JS `APPLE_YEARS`.
    static var appleYears: [Int] { appleYears(throughYear: currentYear) }
    static func appleYears(throughYear year: Int) -> [Int] { Array(2020 ... Swift.max(2020, year)) }
    static var currentYear: Int { Calendar.current.component(.year, from: Date()) }

    /// year → (sessionId → track). Populated by `discover`, read by `fetch`.
    private let cacheLock = NSLock()
    private var tracksByYear: [Int: [String: String]] = [:]

    public init() {}

    // MARK: - discover

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        // Both corpora concurrently (the JS `Promise.all`); an ASCIIwwdc tree failure
        // fails discovery, an Apple year failure is swallowed to an empty index.
        async let appleTask = discoverAppleKeys(context)
        async let asciiTask = discoverAsciiwwdcKeys(context)
        let appleKeys = await appleTask
        let asciiKeys = try await asciiTask

        // Merge, dedupe by key (preserving first-seen order).
        var seen = Set<String>()
        var keys: [String] = []
        for key in appleKeys + asciiKeys where seen.insert(key).inserted { keys.append(key) }

        let root = DiscoveredRoot(
            slug: Self.rootSlug, displayName: Self.displayName, kind: "collection", source: Self.rootSlug)
        return DiscoveryResult(keys: keys, roots: [root])
    }

    /// Apple session keys for 2020+. Each year index is fetched concurrently; the tracks
    /// are cached for `fetch`, and a failed year contributes no keys (and an empty cache).
    private func discoverAppleKeys(_ context: SourceContext) async -> [String] {
        let years = Self.appleYears
        var indices: [Int: YearIndex] = [:]
        await withTaskGroup(of: YearIndex.self) { group in
            for year in years {
                group.addTask { await Self.fetchAppleYearIndex(year: year, context: context) }
            }
            for await index in group { indices[index.year] = index }
        }
        // Store tracks + build keys in ascending-year order (deterministic; the JS
        // Promise.all push order is non-deterministic, but keys are deduped downstream).
        var keys: [String] = []
        for year in years {
            let index = indices[year] ?? YearIndex(year: year, sessionIds: [], tracks: [:])
            storeTracks(year, index.tracks)
            for id in index.sessionIds { keys.append(Self.buildKey(year: year, sessionId: id)) }
        }
        return keys
    }

    /// ASCIIwwdc session keys for 1997–2019 from the repo git tree.
    private func discoverAsciiwwdcKeys(_ context: SourceContext) async throws -> [String] {
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
        let tree = try await github.fetchTree(
            owner: Self.asciiwwdcOwner, repo: Self.asciiwwdcRepo, branch: Self.asciiwwdcBranch)
        var keys: [String] = []
        for entry in tree {
            guard entry.type == "blob", entry.path.hasSuffix(".vtt"),
                let parsed = Self.parseAsciiwwdcPath(entry.path),
                parsed.year >= Self.asciiwwdcYearMin, parsed.year <= Self.asciiwwdcYearMax
            else { continue }
            keys.append(Self.buildKey(year: parsed.year, sessionId: parsed.sessionId))
        }
        return keys
    }

    // MARK: - fetch

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        guard let parsed = Self.parseWwdcKey(key) else {
            throw AdapterError.unexpectedPayload("Invalid WWDC key: \(key)")
        }
        let (year, sessionId) = parsed

        if year >= 2020 {
            let session = try await Self.fetchAppleSession(year: year, sessionId: sessionId, context: context)
            let track = await lookupTrack(year: year, sessionId: sessionId, context: context)
            var dict = session.parsed
            if let track { dict["track"] = track }  // JS: `if (track) payload.track = track`
            let bytes = (try? JSONSerialization.data(withJSONObject: dict)).map(Array.init) ?? []
            return FetchResult(
                key: key, payload: .json(bytes), etag: session.etag, lastModified: session.lastModified)
        }

        // Pre-2020: raw ASCIIwwdc `.vtt`.
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
        let raw = try await github.fetchRaw(
            owner: Self.asciiwwdcOwner, repo: Self.asciiwwdcRepo, branch: Self.asciiwwdcBranch,
            filePath: Self.buildAsciiwwdcPath(year: year, sessionId: sessionId))
        return FetchResult(key: key, payload: .markdown(raw.text), etag: raw.etag, lastModified: raw.lastModified)
    }

    // MARK: - check

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
        -> CheckResult
    {
        guard let parsed = Self.parseWwdcKey(key) else {
            return CheckResult(status: .error, changed: false, newState: previousState)
        }
        let (year, sessionId) = parsed

        if year >= 2020 {
            // Conditional HEAD on the session play page (the JS `checkHtmlPage`).
            try await context.rateLimiter.acquire()
            let url = "\(Self.appleBase)/wwdc\(year)/\(sessionId)/"
            guard let parsedURL = URL(string: url) else { return CheckResult(status: .error, changed: false) }
            var head = HTTPRequest(url: parsedURL)
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

        // Pre-2020: conditional-GET check on the raw `.vtt` (the JS `checkRawGitHub`).
        let github = GitHubClient(client: context.client, rateLimiter: context.rateLimiter)
        return try await github.checkRaw(
            owner: Self.asciiwwdcOwner, repo: Self.asciiwwdcRepo, branch: Self.asciiwwdcBranch,
            filePath: Self.buildAsciiwwdcPath(year: year, sessionId: sessionId), previousEtag: previousState)
    }

    // MARK: - normalize (pure)

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        guard let parsed = Self.parseWwdcKey(key) else {
            throw AdapterError.unexpectedPayload("Invalid WWDC key: \(key)")
        }
        let (year, sessionId) = parsed

        if year >= 2020 {
            guard case .json(let bytes) = payload else {
                throw AdapterError.unexpectedPayload("wwdc apple expects a json payload, got \(payload)")
            }
            guard let json = (try? JSONSerialization.jsonObject(with: Data(bytes))) as? [String: Any] else {
                throw AdapterError.unexpectedPayload("wwdc: malformed apple payload for \(key)")
            }
            return Self.normalizeApple(key: key, json: json, year: year, sessionId: sessionId)
        }

        guard case .markdown(let rawText) = payload else {
            throw AdapterError.unexpectedPayload("wwdc asciiwwdc expects a markdown payload, got \(payload)")
        }
        return Self.normalizeAsciiwwdc(key: key, rawText: rawText, year: year, sessionId: sessionId)
    }

    /// `#normalizeApple` — the scraped-session document.
    static func normalizeApple(key: String, json: [String: Any], year: Int, sessionId: String)
        -> NormalizedPage
    {
        let title = extractAppleTitle(json, year: year, sessionId: sessionId)
        let description = extractAppleDescription(json)
        let transcript = extractAppleTranscript(json)
        let url = "\(appleBase)/wwdc\(year)/\(sessionId)/"

        let track: String?
        if let raw = json["track"] as? String {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            track = trimmed.isEmpty ? nil : trimmed
        } else {
            track = nil
        }

        var metaPairs: [(String, JsJson)] = [
            ("year", .int(year)), ("sessionId", .string(sessionId)), ("source", .string("apple"))
        ]
        if let track { metaPairs.append(("track", .string(track))) }
        let sourceMetadata = JsJson.object(metaPairs).serialized()

        let document = NormalizedDocument(
            sourceType: type, key: key, title: title, kind: "wwdc-session", role: "article",
            roleHeading: nil, framework: rootSlug, url: url, language: nil,
            abstractText: description, declarationText: nil, platformsJson: nil, minIos: nil,
            minMacos: nil, minWatchos: nil, minTvos: nil, minVisionos: nil, isDeprecated: false,
            isBeta: false, isReleaseNotes: false,
            urlDepth: key.split(separator: "/", omittingEmptySubsequences: false).count - 1,
            headings: nil, sourceMetadata: sourceMetadata)

        var sections: [NormalizedSection] = []
        var order = 0
        if let description {
            sections.append(
                NormalizedSection(
                    sectionKind: "abstract", heading: nil, contentText: description, contentJson: nil,
                    sortOrder: order))
            order += 1
        }
        let chapters = (json["chapters"] as? [Any])?.compactMap { $0 as? String } ?? []
        if !chapters.isEmpty {
            sections.append(
                NormalizedSection(
                    sectionKind: "content", heading: "Chapters",
                    contentText: chapters.joined(separator: "\n"), contentJson: nil, sortOrder: order))
            order += 1
        }
        if let text = transcript.text {
            sections.append(
                NormalizedSection(
                    sectionKind: transcript.nodesJSON != nil ? "discussion" : "content",
                    heading: "Transcript", contentText: text, contentJson: transcript.nodesJSON,
                    sortOrder: order))
            order += 1
        }

        return NormalizedPage(document: document, sections: sections, relationships: [])
    }

    /// `#normalizeAsciiwwdc` — the cleaned community-transcript document.
    static func normalizeAsciiwwdc(key: String, rawText: String, year: Int, sessionId: String)
        -> NormalizedPage
    {
        let text = normalizeAsciiwwdcTranscript(rawText)
        let title = extractAsciiwwdcTitle(rawText, year: year, sessionId: sessionId)
        let url = "\(appleBase)/wwdc\(year)/\(sessionId)/"

        let sourceMetadata =
            JsJson.object([
                ("year", .int(year)), ("sessionId", .string(sessionId)), ("source", .string("asciiwwdc"))
            ])
            .serialized()

        let document = NormalizedDocument(
            sourceType: type, key: key, title: title, kind: "wwdc-session", role: "article",
            roleHeading: nil, framework: rootSlug, url: url, language: nil, abstractText: nil,
            declarationText: nil, platformsJson: nil, minIos: nil, minMacos: nil, minWatchos: nil,
            minTvos: nil, minVisionos: nil, isDeprecated: false, isBeta: false, isReleaseNotes: false,
            urlDepth: key.split(separator: "/", omittingEmptySubsequences: false).count - 1,
            headings: nil, sourceMetadata: sourceMetadata)

        let sections = [
            NormalizedSection(
                sectionKind: "content", heading: "Transcript", contentText: text, contentJson: nil,
                sortOrder: 0)
        ]
        return NormalizedPage(document: document, sections: sections, relationships: [])
    }

    // MARK: - keys (wwdc/constants.js)

    /// `parseWwdcKey` — `wwdc/wwdc2024-10001` → (2024, "10001"); nil on a shape mismatch.
    static func parseWwdcKey(_ key: String) -> (year: Int, sessionId: String)? {
        guard let match = firstMatch("^wwdc/wwdc(\\d{4})-(\\d+)$", key) else { return nil }
        let ns = key as NSString
        guard let year = Int(ns.substring(with: match.range(at: 1))) else { return nil }
        return (year, ns.substring(with: match.range(at: 2)))
    }

    static func buildKey(year: Int, sessionId: String) -> String { "\(rootSlug)/wwdc\(year)-\(sessionId)" }

    static func buildAsciiwwdcPath(year: Int, sessionId: String) -> String {
        "\(asciiwwdcLanguage)/\(year)/\(sessionId).vtt"
    }

    /// `en/<year>/<sessionId>.vtt` → (year, sessionId); nil otherwise.
    static func parseAsciiwwdcPath(_ path: String) -> (year: Int, sessionId: String)? {
        guard let match = firstMatch("^\(asciiwwdcLanguage)/(\\d{4})/(\\d+)\\.vtt$", path) else { return nil }
        let ns = path as NSString
        guard let year = Int(ns.substring(with: match.range(at: 1))) else { return nil }
        return (year, ns.substring(with: match.range(at: 2)))
    }

    // MARK: - track cache

    private func cachedTracks(_ year: Int) -> [String: String]? {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        return tracksByYear[year]
    }

    private func storeTracks(_ year: Int, _ tracks: [String: String]) {
        cacheLock.lock()
        defer { cacheLock.unlock() }
        if tracksByYear[year] == nil { tracksByYear[year] = tracks }
    }

    /// `#lookupTrack` — the year's memoized track for a session, fetching the index lazily
    /// when `fetch` runs without a prior `discover` (the cache is otherwise pre-populated).
    private func lookupTrack(year: Int, sessionId: String, context: SourceContext) async -> String? {
        if let tracks = cachedTracks(year) { return tracks[sessionId] }
        let index = await Self.fetchAppleYearIndex(year: year, context: context)
        storeTracks(year, index.tracks)
        return index.tracks[sessionId]
    }

    // MARK: - Apple HTML fetch (wwdc/apple-html.js)

    private struct YearIndex: Sendable {
        let year: Int
        let sessionIds: [String]
        let tracks: [String: String]
    }

    /// Fetch + scrape a year-index page; any failure (non-2xx, transport, decode) yields an
    /// empty index (the JS `emptyYearIndex()` catch-all).
    private static func fetchAppleYearIndex(year: Int, context: SourceContext) async -> YearIndex {
        let url = "\(appleVideosIndex)/wwdc\(year)/"
        guard let parsedURL = URL(string: url) else { return YearIndex(year: year, sessionIds: [], tracks: [:]) }
        var head = HTTPRequest(url: parsedURL)
        head.method = .get
        head.headerFields[.userAgent] = userAgent
        do {
            let response = try await RetryPolicy.fetchWithRetry(
                HTTPClientRequest(head, deadline: .seconds(30)), using: context.client,
                rateLimiter: context.rateLimiter)
            guard (200 ..< 300).contains(response.status.code) else {
                return YearIndex(year: year, sessionIds: [], tracks: [:])
            }
            let bytes = try await response.body.collect(upTo: bodyLimit)
            let html = String(decoding: bytes, as: UTF8.self)
            return YearIndex(
                year: year, sessionIds: extractSessionIds(html, year: year),
                tracks: extractSessionTracks(html, year: year))
        } catch {
            return YearIndex(year: year, sessionIds: [], tracks: [:])
        }
    }

    /// Fetch + scrape one session play page; 404 / non-2xx throw (the JS `fetchAppleSession`).
    private static func fetchAppleSession(year: Int, sessionId: String, context: SourceContext)
        async throws -> (parsed: [String: Any], etag: String?, lastModified: String?)
    {
        let url = "\(appleBase)/wwdc\(year)/\(sessionId)/"
        guard let parsedURL = URL(string: url) else {
            throw AdapterError.unexpectedPayload("wwdc: malformed URL \(url)")
        }
        var head = HTTPRequest(url: parsedURL)
        head.method = .get
        head.headerFields[.userAgent] = userAgent
        let response = try await RetryPolicy.fetchWithRetry(
            HTTPClientRequest(head, deadline: .seconds(30)), using: context.client,
            rateLimiter: context.rateLimiter)
        let status = response.status.code
        if status == 404 { throw AdapterError.httpStatus(404, url) }
        guard (200 ..< 300).contains(status) else { throw AdapterError.httpStatus(status, url) }
        let bytes = try await response.body.collect(upTo: bodyLimit)
        let html = String(decoding: bytes, as: UTF8.self)
        return (parseSessionHtml(html, year: year, sessionId: sessionId), response.etag, response.lastModified)
    }

    /// `extractSessionIdsFromHtml` — unique session IDs from `/videos/play/wwdc{year}/{id}/` links.
    static func extractSessionIds(_ html: String, year: Int) -> [String] {
        var seen = Set<String>()
        var ids: [String] = []
        for id in regexGroups("/videos/play/wwdc\(year)/(\\d+)/?[\"']", in: html, group: 1)
        where seen.insert(id).inserted {
            ids.append(id)
        }
        return ids
    }

    /// `extractSessionTracksFromHtml` — sessionId → pipe-separated topic string, read from
    /// each session card's `data-filter-topics` attribute.
    static func extractSessionTracks(_ html: String, year: Int) -> [String: String] {
        let ns = html as NSString
        let anchorPattern = "<a\\s[^>]*href=\"/videos/play/wwdc\(year)/(\\d+)/?\"[^>]*>"
        guard let regex = try? NSRegularExpression(pattern: anchorPattern, options: [.caseInsensitive]) else {
            return [:]
        }
        let anchors = regex.matches(in: html, range: NSRange(location: 0, length: ns.length))
        var tracks: [String: String] = [:]
        for (index, anchor) in anchors.enumerated() {
            guard anchor.numberOfRanges > 1, anchor.range(at: 1).location != NSNotFound else { continue }
            let sessionId = ns.substring(with: anchor.range(at: 1))
            if tracks[sessionId] != nil { continue }
            let start = anchor.range.location
            let end = index + 1 < anchors.count ? anchors[index + 1].range.location : ns.length
            let card = ns.substring(with: NSRange(location: start, length: end - start))
            if let topics = firstGroup("data-filter-topics=\"([^\"]*)\"", card, options: [.caseInsensitive]) {
                let track = collapseWhitespace(decodeHtmlEntities(topics))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if !track.isEmpty { tracks[sessionId] = track }
            }
        }
        return tracks
    }

    /// `parseSessionHtml` — a session play page into `{title, description, chapters,
    /// transcript, year, sessionId, format}` (the JS structured payload).
    static func parseSessionHtml(_ html: String, year: Int, sessionId: String) -> [String: Any] {
        // Strip noise elements (site chrome), iterating each tag to a fixed point.
        var cleaned = html
        for tag in ["script", "style", "noscript", "nav", "header", "footer"] {
            guard
                let regex = try? NSRegularExpression(
                    pattern: "<\(tag)[\\s>][\\s\\S]*?</\(tag)>", options: [.caseInsensitive])
            else { continue }
            var previous: String
            repeat {
                previous = cleaned
                cleaned = regex.stringByReplacingMatches(
                    in: cleaned, range: NSRange(location: 0, length: (cleaned as NSString).length),
                    withTemplate: "")
            } while cleaned != previous
        }

        let cleanedNS = cleaned as NSString
        var title: Any = NSNull()
        var afterH1 = cleaned
        if let h1 = firstMatch("<h1[^>]*>([\\s\\S]*?)</h1>", cleaned, options: [.caseInsensitive]) {
            title = stripHtmlTags(cleanedNS.substring(with: h1.range(at: 1)))
            afterH1 = cleanedNS.substring(from: h1.range.location + h1.range.length)
        }

        let allParagraphs = regexGroups(
            "<p[^>]*>([\\s\\S]*?)</p>", in: afterH1, group: 1, options: [.caseInsensitive]
        )
        .map { stripHtmlTags($0) }.filter { !$0.isEmpty }

        // Description: first substantial paragraph (the abstract), else the first.
        let description = allParagraphs.first(where: { jsLength($0) > 30 }) ?? allParagraphs.first
        let descIndex = description.flatMap { allParagraphs.firstIndex(of: $0) } ?? -1

        let chapters = extractChapters(cleaned)

        // Transcript: substantial paragraphs after the description.
        var transcript: Any = NSNull()
        if descIndex >= 0 {
            let tail = Array(allParagraphs[(descIndex + 1)...]).filter { jsLength($0) > 15 }
            let joined = tail.joined(separator: "\n\n")
            if !joined.isEmpty { transcript = joined }
        }

        return [
            "title": title,
            "description": description.map { $0 as Any } ?? NSNull(),
            "chapters": chapters,
            "transcript": transcript,
            "year": year,
            "sessionId": sessionId,
            "format": "html"
        ]
    }

    /// `extractChaptersFromHtml` — the `<h2>Chapters</h2><ul>…</ul>` list items.
    static func extractChapters(_ html: String) -> [String] {
        guard
            let match = firstMatch(
                "<h2[^>]*>\\s*Chapters\\s*</h2>\\s*<ul[^>]*>([\\s\\S]*?)</ul>", html, options: [.caseInsensitive])
        else { return [] }
        let inner = (html as NSString).substring(with: match.range(at: 1))
        return regexGroups("<li[^>]*>([\\s\\S]*?)</li>", in: inner, group: 1, options: [.caseInsensitive])
            .map { stripHtmlTags($0) }.filter { !$0.isEmpty }
    }

    /// `stripHtmlTags` — drop tags, collapse whitespace, decode entities, trim.
    static func stripHtmlTags(_ html: String) -> String {
        let noTags = replaceRegex("<[^>]+>", in: html, with: " ")
        let collapsed = collapseWhitespace(noTags)
        return decodeHtmlEntities(collapsed).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// `decodeHtmlEntities` — decode `&amp;` LAST so `&amp;lt;` round-trips to `&lt;`.
    static func decodeHtmlEntities(_ value: String) -> String {
        var out = value
        out = out.replacingOccurrences(of: "&gt;", with: ">")
        out = out.replacingOccurrences(of: "&lt;", with: "<")
        out = out.replacingOccurrences(of: "&#39;", with: "'")
        out = out.replacingOccurrences(of: "&quot;", with: "\"")
        out = out.replacingOccurrences(of: "&amp;", with: "&")
        return out
    }

    // MARK: - Apple transcript / title / description (wwdc/transcript.js)

    /// `extractAppleTranscript` — the first transcript-like block, plus the raw render-tree
    /// nodes (JSON) when a structured section supplied them (nil for the HTML scrape).
    static func extractAppleTranscript(_ json: [String: Any]) -> (text: String?, nodesJSON: String?) {
        if let candidate = deepFind(json, "transcript") as? String, !candidate.isEmpty {
            return (candidate, nil)
        }
        let sections = (json["primaryContentSections"] as? [Any]) ?? (json["sections"] as? [Any]) ?? []
        var texts: [String] = []
        var allNodes: [Any] = []
        for case let section as [String: Any] in sections {
            let kind = section["kind"] as? String
            if kind == "content" || kind == "transcript" {
                let contentNodes = (section["content"] as? [Any]) ?? []
                texts.append(contentsOf: collectInlineText(contentNodes))
                allNodes.append(contentsOf: contentNodes)
            }
        }
        if texts.isEmpty { return (nil, nil) }
        return (texts.joined(separator: "\n\n"), allNodes.isEmpty ? nil : serializeNodes(allNodes))
    }

    /// `extractAppleDescription` — description, else abstract-section text, else metadata.
    static func extractAppleDescription(_ json: [String: Any]) -> String? {
        if let description = json["description"] as? String, !description.isEmpty { return description }
        if let sections = json["primaryContentSections"] as? [Any] {
            for case let section as [String: Any] in sections where section["kind"] as? String == "abstract" {
                let parts = collectInlineText((section["content"] as? [Any]) ?? [])
                if !parts.isEmpty { return parts.joined(separator: " ") }
                break
            }
        }
        if let metadata = json["metadata"] as? [String: Any], let description = metadata["description"] as? String {
            return description
        }
        return nil
    }

    /// `extractAppleTitle` — title / metadata title / deep-found title, else the session fallback.
    static func extractAppleTitle(_ json: [String: Any], year: Int, sessionId: String) -> String {
        let metadataTitle = (json["metadata"] as? [String: Any])?["title"]
        let candidate = coalesce(json["title"], metadataTitle, deepFind(json, "title"))
        if let title = candidate as? String, !title.isEmpty { return title }
        return "WWDC\(year) Session \(sessionId)"
    }

    /// `extractAsciiwwdcTitle` — a leading heading line, else the session number.
    static func extractAsciiwwdcTitle(_ text: String, year: Int, sessionId: String) -> String {
        let fallback = "WWDC\(year) Session \(sessionId)"
        let firstRaw = text.components(separatedBy: "\n").first ?? ""
        if text.contains("WEBVTT")
            || matchesVttTimestamp(firstRaw.trimmingCharacters(in: .whitespacesAndNewlines))
        {
            return fallback
        }
        guard
            let firstLine = text.components(separatedBy: "\n")
                .first(where: {
                    !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                })
        else { return fallback }

        let candidate = firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
        if firstMatch("^\\[?\\d{2}:\\d{2}", candidate) == nil, jsLength(candidate) > 0, jsLength(candidate) < 200 {
            return candidate
        }
        return fallback
    }

    /// `normalizeAsciiwwdcTranscript` — VTT/plain text → cleaned, deduped transcript lines.
    static func normalizeAsciiwwdcTranscript(_ text: String) -> String {
        let normalized = replaceRegex("\\r\\n?", in: text, with: "\n")
        var cleaned: [String] = []
        for rawLine in normalized.components(separatedBy: "\n") {
            // Strip every inline tag iteratively so nested/back-to-back `<<x>>` leave no stray `<`.
            var stripped = decodeHtmlEntities(rawLine)
            var previous: String
            repeat {
                previous = stripped
                stripped = replaceRegex("<[^>]+>", in: stripped, with: "")
            } while stripped != previous

            let line = stripped.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            if line == "WEBVTT" { continue }
            if isAllDigits(line) { continue }
            if line.hasPrefix("NOTE") { continue }
            if matchesVttTimestamp(line) { continue }
            if cleaned.last == line { continue }
            cleaned.append(line)
        }
        return cleaned.joined(separator: "\n")
    }

    // MARK: - JSON tree walkers (wwdc/transcript.js)

    /// `deepFind` — the first value at `key` in a decoded-JSON tree (depth-bounded).
    static func deepFind(_ object: Any?, _ key: String, maxDepth: Int = 6) -> Any? {
        guard maxDepth > 0, let object else { return nil }
        if let dict = object as? [String: Any] {
            if let value = dict[key] { return value }
            for value in dict.values {
                if let found = deepFind(value, key, maxDepth: maxDepth - 1) { return found }
            }
        } else if let array = object as? [Any] {
            for value in array {
                if let found = deepFind(value, key, maxDepth: maxDepth - 1) { return found }
            }
        }
        return nil
    }

    /// `collectInlineText` — plain strings from a DocC render-tree content array.
    static func collectInlineText(_ content: Any?) -> [String] {
        guard let nodes = content as? [Any] else { return [] }
        var texts: [String] = []
        for case let node as [String: Any] in nodes {
            switch node["type"] as? String {
                case "text":
                    if let text = node["text"] as? String { texts.append(text) }
                case "codeVoice":
                    if let code = node["code"] as? String { texts.append(code) }
                case "codeListing":
                    let lines = (node["code"] as? [Any])?.compactMap { $0 as? String } ?? []
                    texts.append(lines.joined(separator: "\n"))
                case "paragraph":
                    texts.append(contentsOf: collectInlineText(node["inlineContent"]))
                default:
                    if let inline = node["inlineContent"] as? [Any] {
                        texts.append(contentsOf: collectInlineText(inline))
                    } else if let children = node["content"] as? [Any] {
                        texts.append(contentsOf: collectInlineText(children))
                    }
            }
        }
        return texts
    }

    /// `JSON.stringify(nodes)` for the (structured-only) transcript render tree.
    private static func serializeNodes(_ nodes: [Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: nodes) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - regex + string helpers (NSString / UTF-16, matching JS)

    static func firstMatch(_ pattern: String, _ text: String, options: NSRegularExpression.Options = [])
        -> NSTextCheckingResult?
    {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
        return regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length))
    }

    static func firstGroup(_ pattern: String, _ text: String, options: NSRegularExpression.Options = [])
        -> String?
    {
        guard let match = firstMatch(pattern, text, options: options), match.numberOfRanges > 1 else {
            return nil
        }
        let range = match.range(at: 1)
        return range.location == NSNotFound ? nil : (text as NSString).substring(with: range)
    }

    static func regexGroups(
        _ pattern: String, in text: String, group: Int, options: NSRegularExpression.Options = []
    ) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return [] }
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
            .compactMap { match in
                guard match.numberOfRanges > group, match.range(at: group).location != NSNotFound else {
                    return nil
                }
                return ns.substring(with: match.range(at: group))
            }
    }

    static func replaceRegex(_ pattern: String, in text: String, with template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        let ns = text as NSString
        return regex.stringByReplacingMatches(
            in: text, range: NSRange(location: 0, length: ns.length), withTemplate: template)
    }

    /// `/\s+/g` → ' '.
    static func collapseWhitespace(_ text: String) -> String { replaceRegex("\\s+", in: text, with: " ") }

    static func matchesVttTimestamp(_ line: String) -> Bool {
        guard let regex = vttTimestampRegex else { return false }
        return regex.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) != nil
    }

    /// `/^\d+$/` — a non-empty run of ASCII digits.
    static func isAllDigits(_ text: String) -> Bool {
        !text.isEmpty && text.unicodeScalars.allSatisfy { $0.value >= 48 && $0.value <= 57 }
    }

    /// JS `String.length` (UTF-16 code units), for byte-faithful length thresholds.
    static func jsLength(_ text: String) -> Int { text.utf16.count }

    /// JS `a ?? b ?? c` — the first value that is neither nil nor `NSNull` (JS nullish).
    static func coalesce(_ values: Any?...) -> Any? {
        for value in values {
            guard let value else { continue }
            if value is NSNull { continue }
            return value
        }
        return nil
    }
}
