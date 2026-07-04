// AppleArchiveAdapter — the frozen Apple Developer Archive (port of
// src/sources/apple-archive.js). Discovery parses Apple's `library.json`
// catalog (served as a JS OBJECT LITERAL, not strict JSON — the same sanitize
// pass is ported) into guide entries; fetch GETs each guide's HTML (or HEADs a
// PDF for metadata); `check` always reports `unchanged` (the archive is
// frozen — the JS never re-fetches); normalize parses the `#contents`
// container via ADHTML (or emits the fixed PDF pointer document).
//
// A `final class` (like SwiftBookAdapter): the guide catalog is built in
// `discover` and read by `fetch`/`normalize` on the same instance.

// swiftlint:disable type_body_length

import Foundation
import HTTPTypes
import HTTPTypesFoundation

public final class AppleArchiveAdapter: SourceAdapter, @unchecked Sendable {
    public static let type = "apple-archive"
    public static let displayName = "Apple Developer Archive"
    public static let syncMode = SyncMode.flat

    static let rootSlug = "apple-archive"
    static let archiveBase = "https://developer.apple.com/library/archive"
    static let libraryURL = "\(archiveBase)/navigation/library.json"
    static let guideResourceTypeKey = "3"
    static let supportedFormats: Set<String> = ["html", "htm", "pdf"]
    static let userAgent = "apple-docs/2.0"
    static let bodyLimit = 32 << 20

    static let knownMissingArchivePaths: Set<String> = [
        "documentation/Hardware/hardware2.html",
        "documentation/Hardware/legacy/legacy.html",
        "documentation/Carbon/Conceptual/DesktopIcons/ch13.html",
        "documentation/Carbon/Conceptual/DragMgrProgrammersGuide/DragMgrProgrammersGuide.pdf",
        "documentation/General/Conceptual/Apple_News_Format_Ref/index.html",
        "documentation/General/Conceptual/News_API_Ref/index.html",
        "documentation/Performance/Conceptual/Mac_OSX_Numerics/Mac_OSX_Numerics.pdf",
        "documentation/General/Conceptual/AppStoreSearchAdsAPIReference/index.html",
        "documentation/QuickTime/whatsnew.htm"
    ]

    /// One library.json guide entry (the JS catalog value).
    struct GuideEntry: Sendable {
        let key: String
        let title: String?
        let url: String
        let sourceMetadata: String
        let format: String
    }

    /// Built by `discover`, read by `fetch`/`normalize` on the same instance.
    private var guideCatalog: [String: GuideEntry] = [:]
    private var catalogOrder: [String] = []

    public init() {}

    // MARK: - discover

    public func discover(_ context: SourceContext) async throws -> DiscoveryResult {
        let catalog = try await loadGuideCatalog(context)
        let root = DiscoveredRoot(
            slug: Self.rootSlug, displayName: Self.displayName, kind: "collection",
            source: Self.rootSlug)
        return DiscoveryResult(keys: catalog, roots: [root])
    }

    // MARK: - fetch

    public func fetch(_ key: String, _ context: SourceContext) async throws -> FetchResult {
        if guideCatalog.isEmpty { _ = try await loadGuideCatalog(context) }
        let entry = guideCatalog[key]
        let url = entry?.url ?? Self.keyToFallbackUrl(key)

        if entry?.format == "pdf" {
            // HEAD for validators only — the PDF body is never downloaded; the
            // payload carries the pointer fields normalize embeds.
            try await context.rateLimiter.acquire()
            guard let requestURL = URL(string: url) else {
                throw AdapterError.unexpectedPayload("apple-archive: malformed URL for \(key)")
            }
            var head = HTTPRequest(url: requestURL)
            head.method = .head
            head.headerFields[.userAgent] = Self.userAgent
            let response = try await context.client.send(HTTPClientRequest(head, deadline: .seconds(30)))
            guard (200 ..< 300).contains(response.status.code) else {
                throw AdapterError.httpStatus(response.status.code, url)
            }
            let payload =
                JsJson.object([
                    ("format", .string("pdf")),
                    ("url", .string(url)),
                    ("title", entry?.title.map(JsJson.string) ?? .null),
                    ("sourceMetadata", entry.map { JsJson.string($0.sourceMetadata) } ?? .null)
                ])
                .serialized()
            return FetchResult(
                key: key, payload: .json(Array(payload.utf8)), etag: response.etag,
                lastModified: response.lastModified)
        }

        guard let requestURL = URL(string: url) else {
            throw AdapterError.unexpectedPayload("apple-archive: malformed URL for \(key)")
        }
        var get = HTTPRequest(url: requestURL)
        get.method = .get
        get.headerFields[.userAgent] = Self.userAgent
        let response = try await RetryPolicy.fetchWithRetry(
            HTTPClientRequest(get, deadline: .seconds(30)), using: context.client,
            rateLimiter: context.rateLimiter)
        let bytes = try await response.body.collect(upTo: Self.bodyLimit)
        return FetchResult(
            key: key, payload: .html(String(decoding: bytes, as: UTF8.self)), etag: response.etag,
            lastModified: response.lastModified)
    }

    // MARK: - check (archive content is frozen)

    public func check(_ key: String, previousState: String?, _ context: SourceContext) async throws
        -> CheckResult
    {
        CheckResult(status: .unchanged, changed: false)
    }

    // MARK: - normalize

    public func normalize(_ key: String, _ payload: SourcePayload) throws -> NormalizedPage {
        let entry = guideCatalog[key]
        let url = entry?.url ?? Self.keyToFallbackUrl(key)
        let framework = Self.deriveFramework(key)

        // PDF: the pointer document (payload carries format/url/title/metadata
        // when the catalog isn't warm on this instance).
        if case .json(let bytes) = payload {
            let fields = Self.parsePdfPayload(bytes)
            let format = entry?.format ?? fields.format
            if format == "pdf" {
                return Self.pdfPage(
                    key: key, url: url, framework: framework,
                    title: entry?.title ?? fields.title,
                    sourceMetadata: entry?.sourceMetadata ?? fields.sourceMetadata)
            }
            throw AdapterError.unexpectedPayload("apple-archive: unexpected json payload for \(key)")
        }

        guard case .html(let html) = payload else {
            throw AdapterError.unexpectedPayload("apple-archive expects html or pdf metadata, got \(payload)")
        }
        return HtmlNormalize.parse(
            html, key: key, sourceType: Self.type, kind: "archive-guide", framework: framework,
            url: url, sourceMetadata: entry?.sourceMetadata, containerSelector: "#contents",
            preserveStructure: true)
    }

    /// The fixed PDF pointer page (the JS pdf normalize branch, field-for-field).
    static func pdfPage(
        key: String, url: String, framework: String?, title: String?, sourceMetadata: String?
    ) -> NormalizedPage {
        let fallbackTitle = key.split(separator: "/").last.map(String.init) ?? key
        return NormalizedPage(
            document: NormalizedDocument(
                sourceType: type, key: key, title: title ?? fallbackTitle, kind: "archive-guide",
                role: "article", roleHeading: nil, framework: framework, url: url, language: nil,
                abstractText: "Archived PDF guide. Open the original PDF URL for the full document.",
                declarationText: nil, platformsJson: nil, minIos: nil, minMacos: nil,
                minWatchos: nil, minTvos: nil, minVisionos: nil, isDeprecated: false,
                isBeta: false, isReleaseNotes: false,
                urlDepth: key.split(separator: "/", omittingEmptySubsequences: false).count - 1,
                headings: nil, sourceMetadata: sourceMetadata),
            sections: [
                NormalizedSection(
                    sectionKind: "discussion", heading: "Original PDF",
                    contentText:
                        "This archive guide is only available as a PDF.\n\nOpen the original document: \(url)",
                    sortOrder: 0)
            ],
            relationships: [])
    }

    // MARK: - the guide catalog (library.json)

    /// Fetch + parse library.json once per instance; returns the ordered keys.
    private func loadGuideCatalog(_ context: SourceContext) async throws -> [String] {
        if !catalogOrder.isEmpty { return catalogOrder }
        try await context.rateLimiter.acquire()
        guard let url = URL(string: Self.libraryURL) else {
            throw AdapterError.unexpectedPayload("apple-archive: malformed library URL")
        }
        var get = HTTPRequest(url: url)
        get.method = .get
        get.headerFields[.userAgent] = Self.userAgent
        let response = try await context.client.send(HTTPClientRequest(get, deadline: .seconds(30)))
        guard (200 ..< 300).contains(response.status.code) else {
            throw AdapterError.httpStatus(response.status.code, Self.libraryURL)
        }
        let bytes = try await response.body.collect(upTo: Self.bodyLimit)
        let (entries, order) = try Self.buildGuideCatalog(String(decoding: bytes, as: UTF8.self))
        guideCatalog = entries
        catalogOrder = order
        return order
    }

    /// Parse the library payload and build the guide catalog (the JS
    /// `#loadGuideCatalog` filter chain), preserving document order.
    static func buildGuideCatalog(_ rawText: String) throws -> ([String: GuideEntry], [String]) {
        let library = try parseArchiveLibrary(rawText)
        guard let root = try? JSONSerialization.jsonObject(with: Data(library.utf8)) as? [String: Any]
        else { throw AdapterError.unexpectedPayload("apple-archive: library.json did not parse") }

        let columns = root["columns"] as? [String: Any] ?? [:]
        let typeColumn = (columns["type"] as? NSNumber)?.intValue
        let urlColumn = (columns["url"] as? NSNumber)?.intValue
        let nameColumn = (columns["name"] as? NSNumber)?.intValue
        let platformColumn = (columns["platform"] as? NSNumber)?.intValue

        var entries: [String: GuideEntry] = [:]
        var order: [String] = []
        for documentAny in root["documents"] as? [Any] ?? [] {
            guard let document = documentAny as? [Any] else { continue }
            func cell(_ index: Int?) -> Any? {
                guard let index, index >= 0, index < document.count else { return nil }
                return document[index]
            }
            // `String(document[columns.type] ?? '')`.
            let resourceType = jsStringCoerce(cell(typeColumn))
            guard resourceType == guideResourceTypeKey else { continue }

            let relativeUrl = normalizeArchiveRelativeUrl(jsStringCoerce(cell(urlColumn)))
            let format = archiveFormat(relativeUrl)
            guard relativeUrl.hasPrefix("documentation/") || relativeUrl.hasPrefix("featuredarticles/")
            else { continue }
            guard supportedFormats.contains(format) else { continue }
            guard !knownMissingArchivePaths.contains(relativeUrl) else { continue }

            let key = pathToKey(relativeUrl)
            guard entries[key] == nil else { continue }

            let title = decodeHtmlEntities(cell(nameColumn) as? String)
            let platform = decodeHtmlEntities(cell(platformColumn) as? String)
            let sourceMetadata =
                JsJson.object([
                    ("resourceType", .string("Guides")),
                    ("platform", platform.map(JsJson.string) ?? .null),
                    ("archivePath", .string(relativeUrl)),
                    ("format", .string(format))
                ])
                .serialized()
            entries[key] = GuideEntry(
                key: key, title: title, url: "\(archiveBase)/\(relativeUrl)",
                sourceMetadata: sourceMetadata, format: format)
            order.append(key)
        }
        return (entries, order)
    }

    /// Port of `parseArchiveLibrary`: strict JSON first, else sanitize Apple's
    /// JS object literal (strip wrapping parens, drop trailing commas, quote
    /// bare keys) and parse that. Returns the (possibly sanitized) JSON text.
    static func parseArchiveLibrary(_ rawText: String) throws -> String {
        if (try? JSONSerialization.jsonObject(with: Data(rawText.utf8))) != nil { return rawText }
        var sanitized = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        if sanitized.hasPrefix("(") && sanitized.hasSuffix(")") {
            sanitized = String(sanitized.dropFirst().dropLast())
        }
        sanitized = stripTrailingCommas(sanitized)
        sanitized = quoteBareKeys(sanitized)
        guard (try? JSONSerialization.jsonObject(with: Data(sanitized.utf8))) != nil else {
            throw AdapterError.unexpectedPayload("apple-archive: library.json did not parse")
        }
        return sanitized
    }

    /// `/,\s*([}\]])/g → '$1'`.
    static func stripTrailingCommas(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        let scalars = Array(s.unicodeScalars)
        var i = 0
        while i < scalars.count {
            if scalars[i] == "," {
                var j = i + 1
                while j < scalars.count, isJsSpace(scalars[j]) { j += 1 }
                if j < scalars.count, scalars[j] == "}" || scalars[j] == "]" {
                    i += 1  // drop the comma (the whitespace + bracket re-emit below)
                    continue
                }
            }
            out.append(scalars[i])
            i += 1
        }
        return String(out)
    }

    /// `/([{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g → '$1"$2":'`.
    static func quoteBareKeys(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        let scalars = Array(s.unicodeScalars)
        var i = 0
        while i < scalars.count {
            let scalar = scalars[i]
            out.append(scalar)
            if scalar == "{" || scalar == "," {
                var j = i + 1
                while j < scalars.count, isJsSpace(scalars[j]) { j += 1 }
                // identifier start: [a-zA-Z_$]
                guard j < scalars.count, isIdentStart(scalars[j]) else {
                    i += 1
                    continue
                }
                var k = j
                while k < scalars.count, isIdentPart(scalars[k]) { k += 1 }
                var m = k
                while m < scalars.count, isJsSpace(scalars[m]) { m += 1 }
                guard m < scalars.count, scalars[m] == ":" else {
                    i += 1
                    continue
                }
                // Emit: whitespace run, quoted identifier, colon.
                for w in (i + 1) ..< j { out.append(scalars[w]) }
                out.append("\"")
                for w in j ..< k { out.append(scalars[w]) }
                out.append("\"")
                out.append(":")
                i = m + 1
                continue
            }
            i += 1
        }
        return String(out)
    }

    // MARK: - path/string helpers (ports)

    /// `relativeUrl.replace(/^\.\.\//, '').replace(/#.*$/, '')`.
    static func normalizeArchiveRelativeUrl(_ relativeUrl: String) -> String {
        var out = relativeUrl
        if out.hasPrefix("../") { out = String(out.dropFirst(3)) }
        if let hash = out.firstIndex(of: "#") { out = String(out[..<hash]) }
        return out
    }

    /// Port of `pathToKey`: strip a redundant terminal HTML filename (`index`
    /// or one repeating the parent directory), preserve distinct siblings.
    static func pathToKey(_ guidePath: String) -> String {
        guard let match = htmlLeafMatch(guidePath) else { return "\(rootSlug)/\(guidePath)" }
        let (directoryPath, fileBase, ext) = match
        let parentSegment = directoryPath.split(separator: "/").last.map(String.init) ?? ""
        let lowerBase = fileBase.lowercased()
        if lowerBase == "index" || lowerBase == parentSegment.lowercased() {
            return "\(rootSlug)/\(directoryPath)"
        }
        return "\(rootSlug)/\(directoryPath)/\(fileBase).\(ext)"
    }

    /// `/^(.*)\/([^/]+)\.(html|htm)$/i` → (dir, base, ext) with the ORIGINAL
    /// extension casing (the JS keeps `match[3]` verbatim).
    private static func htmlLeafMatch(_ path: String) -> (String, String, String)? {
        let lower = path.lowercased()
        let ext: String
        if lower.hasSuffix(".html") {
            ext = String(path.suffix(4))
        } else if lower.hasSuffix(".htm") {
            ext = String(path.suffix(3))
        } else {
            return nil
        }
        let withoutExt = String(path.dropLast(ext.count + 1))
        guard let slash = withoutExt.lastIndex(of: "/") else { return nil }  // `(.*)/` needs a slash
        let dir = String(withoutExt[..<slash])
        let base = String(withoutExt[withoutExt.index(after: slash)...])
        guard !base.isEmpty else { return nil }  // `[^/]+`
        return (dir, base, ext)
    }

    /// Port of `keyToFallbackUrl`.
    static func keyToFallbackUrl(_ key: String) -> String {
        let prefix = "\(rootSlug)/"
        let pathPrefix = key.hasPrefix(prefix) ? String(key.dropFirst(prefix.count)) : key
        let lower = pathPrefix.lowercased()
        if lower.hasSuffix(".html") || lower.hasSuffix(".htm") || lower.hasSuffix(".pdf") {
            return "\(archiveBase)/\(pathPrefix)"
        }
        return "\(archiveBase)/\(pathPrefix)/index.html"
    }

    /// Port of `deriveFramework`: `key.split('/')[2]`, lowercased.
    static func deriveFramework(_ key: String) -> String? {
        let parts = key.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count > 2, !parts[2].isEmpty else { return nil }
        return parts[2].lowercased()
    }

    /// Port of `decodeHtmlEntities` (decode `&amp;` LAST — double-encoded
    /// entities round-trip, CodeQL js/double-escaping).
    static func decodeHtmlEntities(_ value: String?) -> String? {
        guard let value else { return nil }
        return
            value
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&amp;", with: "&")
    }

    /// `/\.([a-z0-9]+)$/i` → lowercased extension, default 'html'.
    static func archiveFormat(_ relativeUrl: String) -> String {
        guard let dot = relativeUrl.lastIndex(of: ".") else { return "html" }
        let ext = relativeUrl[relativeUrl.index(after: dot)...]
        guard !ext.isEmpty,
            ext.unicodeScalars.allSatisfy({ isAsciiAlphanumeric($0) })
        else { return "html" }
        return ext.lowercased()
    }

    /// `String(value ?? '')` for the loosely-typed library cells (numbers print
    /// their ECMA form — the type column is typically the number 3).
    static func jsStringCoerce(_ value: Any?) -> String {
        switch value {
            case nil: return ""
            case let string as String: return string
            case let number as NSNumber:
                // Integral numbers print without a fraction (String(3) === '3').
                let double = number.doubleValue
                if double == double.rounded(), abs(double) < 1e15 {
                    return String(Int64(double))
                }
                return "\(number)"
            default: return ""
        }
    }

    // MARK: - the pdf payload round-trip

    private static func parsePdfPayload(_ bytes: [UInt8]) -> (
        format: String?, title: String?, sourceMetadata: String?
    ) {
        guard let object = (try? JSONSerialization.jsonObject(with: Data(bytes))) as? [String: Any]
        else { return (nil, nil, nil) }
        return (
            format: object["format"] as? String, title: object["title"] as? String,
            sourceMetadata: object["sourceMetadata"] as? String
        )
    }

    // MARK: - scalar classes

    private static func isJsSpace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029,
                0x202F, 0x205F, 0x3000, 0xFEFF:
                return true
            default: return false
        }
    }
    private static func isIdentStart(_ s: Unicode.Scalar) -> Bool {
        (s.value >= 65 && s.value <= 90) || (s.value >= 97 && s.value <= 122) || s == "_" || s == "$"
    }
    private static func isIdentPart(_ s: Unicode.Scalar) -> Bool {
        isIdentStart(s) || (s.value >= 48 && s.value <= 57)
    }
    private static func isAsciiAlphanumeric(_ s: Unicode.Scalar) -> Bool {
        (s.value >= 48 && s.value <= 57) || (s.value >= 65 && s.value <= 90)
            || (s.value >= 97 && s.value <= 122)
    }
}
