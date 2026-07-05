// JSON framing for the in-process web routes. Each builder emits bytes via the
// streaming writer (caller-ordered keys). Storage stays typed (ADStorage returns
// facets/rows); presentation lives here.

import ADBase
import ADJSON
import ADServeCore
import ADStorage
import Foundation
// HTTPCore: the response status statics' defining module post engine re-base
// (MemberImportVisibility requires the direct import).
import HTTPCore

enum WebRoutes {
    // `ISO8601DateFormatter` is thread-safe for `string(from:)` once configured, but
    // isn't marked `Sendable` — `nonisolated(unsafe)` is the contained, correct
    // annotation (same category as `IntentDetector`'s `Regex` statics). The endpoint
    // closures dispatch concurrently, so this is shared across requests; hoisting it
    // avoids re-allocating the formatter on every (hot) manifest request. Default
    // options = `.withInternetDateTime` — no fractional seconds, matching prior bytes.
    nonisolated(unsafe) private static let iso8601 = ISO8601DateFormatter()

    /// GET /api/filters body.
    static func filters(_ conn: StorageConnection) -> [UInt8] {
        let facets = conn.searchFilters()
        var w = JSONStreamWriter(capacity: 1024)
        w.beginObject()
        w.key("frameworks")
        w.beginArray()
        for framework in facets.frameworks {
            w.beginObject()
            w.key("label")
            w.string(framework.label)
            w.key("value")
            w.string(framework.value)
            w.endObject()
        }
        w.endArray()
        w.key("kinds")
        w.beginArray()
        for kind in facets.kinds { w.string(kind) }
        w.endArray()
        w.key("wwdcYears")
        w.beginArray()
        for year in facets.wwdcYears {
            w.beginObject()
            w.key("year")
            w.integer(year.year)
            w.key("count")
            w.integer(year.count)
            w.endObject()
        }
        w.endArray()
        w.endObject()
        return w.finish()
    }

    /// GET /api/fonts: `{families:[{id, files:[{id,file_name}]}]}`. The `name` key is
    /// never emitted — the schema has `display_name`, not `name`.
    static func fonts(_ conn: StorageConnection) -> [UInt8] {
        let families = conn.listAppleFonts()
            .map { family in
                FontsResponse.Family(
                    id: family.id,
                    files: family.files.map { FontsResponse.File(id: $0.id, file_name: $0.fileName) })
            }
        return WebJSON.encode(FontsResponse(families: families))
    }

    /// GET /api/fonts/faces.css.
    static func fontFacesCss(_ conn: StorageConnection, baseUrl: String) -> [UInt8] {
        let families = conn.listAppleFonts()
        var rules: [String] = []
        for family in families {
            for file in family.files {
                let name = "apple-docs-\(family.id)-\(file.id)"
                let url = "\(baseUrl)/api/fonts/file/\(encodeURIComponent(file.id))"
                let format = formatHint(file.format)
                let formatClause = format.isEmpty ? "" : " format(\"\(format)\")"
                rules.append(
                    "@font-face { font-family: \"\(name)\"; src: url(\"\(url)\")\(formatClause); font-display: swap; }"
                )
            }
        }
        return Array(rules.joined(separator: "\n").utf8)
    }

    /// GET /api/symbols/index.json. Built as `JSONValue` because codepoint/codepointVersion
    /// EMIT `null` (not omit).
    static func symbolsIndex(_ conn: StorageConnection) -> [UInt8] {
        let rows = conn.listSfSymbolsCatalog()
        let symbols: [JSONValue] = rows.map { row in
            .object([
                "name": .string(row.name),
                "scope": .string(row.scope),
                "categories": parsedArray(row.categoriesJson),
                "keywords": parsedArray(row.keywordsJson),
                "bitmapOnly": .bool((row.bitmapOnly ?? 0) != 0),
                "renderUnsupported": .bool((row.renderUnsupported ?? 0) != 0),
                "codepoint": intOrNull(row.codepoint),
                "codepointVersion": strOrNull(row.codepointVersion)
            ])
        }
        return encodeJSONValue(
            .object(["count": .number(Double(rows.count)), "symbols": .array(symbols)]))
    }

    /// GET /api/symbols/search. `query` is the RAW q param (echoed un-trimmed);
    /// `scope` nil = all; `limit` already clamped.
    static func symbolsSearch(
        _ conn: StorageConnection, query: String, scope: String?, limit: Int
    ) -> [UInt8] {
        let results = conn.searchSfSymbols(query: query, scope: scope, limit: limit)
            .map { JSONValue.object(symbolRowObject($0)) }
        var obj: OrderedDictionary<String, JSONValue> = [:]
        obj["results"] = .array(results)
        obj["query"] = .string(query)
        obj["scope"] = scope.map { .string($0) } ?? .null
        return encodeJSONValue(.object(obj))
    }

    /// GET /api/symbols/<scope>/<name>.json. nil = 404. Adds `codepoint_display` when
    /// codepoint is set, else OMITs `codepoint` + `codepoint_display`.
    static func symbolMetadata(_ conn: StorageConnection, scope: String, name: String) -> [UInt8]? {
        guard let row = conn.getSfSymbol(scope: scope, name: name) else { return nil }
        var obj = symbolRowObject(row)
        if let cp = row.codepoint {
            obj["codepoint_display"] = .string(codepointDisplay(cp))
        } else {
            obj["codepoint"] = nil
        }
        return encodeJSONValue(.object(obj))
    }

    /// GET /data/search/title-index[.<hash>].json.
    static func titleIndexBytes(_ conn: StorageConnection) -> [UInt8] {
        WebJSON.encode(titleIndexResponse(conn.buildTitleIndex()))
    }

    /// GET /data/search/aliases[.<hash>].json — {alias: canonical}.
    static func aliasMapBytes(_ conn: StorageConnection) -> [UInt8] {
        WebJSON.encode(conn.buildAliasMap())
    }

    /// GET /data/search/search-manifest.json. The title-index/aliases filename hashes
    /// are `sha256(artifact-bytes).slice(0,10)` — ad-server's own bytes, self-coherent.
    static func searchManifest(_ conn: StorageConnection) -> [UInt8] {
        let titleIndex = conn.buildTitleIndex()
        let aliasMap = conn.buildAliasMap()
        let titleBytes = WebJSON.encode(titleIndexResponse(titleIndex))
        let aliasBytes = WebJSON.encode(aliasMap)
        let manifest = SearchManifest(
            version: 2, titleCount: titleIndex.keys.count, aliasCount: aliasMap.count, shardCount: 0,
            files: [
                "title-index": "title-index.\(String(ConditionalRequest.sha256HexLower(titleBytes).prefix(10))).json",
                "aliases": "aliases.\(String(ConditionalRequest.sha256HexLower(aliasBytes).prefix(10))).json"
            ],
            generatedAt: iso8601.string(from: Date()))
        return WebJSON.encode(manifest)
    }

    /// GET /data/frameworks/<slug>/tree.<hash>.json. nil = 404 (no root, or no child edges).
    /// `docs` is a dynamic-key object.
    static func frameworkTree(_ conn: StorageConnection, slug: String, baseUrl: String) -> [UInt8]? {
        guard conn.frameworkRootExists(slug) else { return nil }
        let edges = conn.frameworkTreeEdges(slug)
        guard !edges.isEmpty else { return nil }
        var docs: OrderedDictionary<String, JSONValue> = [:]
        for doc in conn.frameworkTreeDocs(slug) {
            docs[doc.path] = .object([
                "title": .string(doc.title ?? doc.path),
                "role_heading": .string(doc.roleHeading ?? doc.role ?? "Other"),
                "href": .string("\(baseUrl)/docs/\(safeWebDocKey(doc.path))/")
            ])
        }
        let edgeValues: [JSONValue] = edges.map {
            .object(["from_key": .string($0.fromKey), "to_key": .string($0.toKey)])
        }
        return encodeJSONValue(.object(["edges": .array(edgeValues), "docs": .object(docs)]))
    }

    /// GET /readyz — instance readiness (the DB probe). 503 when the read pool can't
    /// answer. The `no-store` cache policy is declared on the route.
    static func readyz(dbOk: Bool) -> ResponseContent {
        var w = JSONStreamWriter(capacity: 96)
        w.beginObject()
        w.key("ok")
        w.bool(dbOk)
        w.key("service")
        w.string("ad-server")
        w.key("db")
        w.bool(dbOk)
        w.key("readerPool")
        w.null()
        w.endObject()
        return .raw(
            body: w.finish(), contentType: "application/json;charset=utf-8",
            status: dbOk ? .ok : .serviceUnavailable)
    }

    /// GET /api/fonts/text.svg?text=&fontId=&size=. `text` nil/empty → "Typography" (JS
    /// `validateFontText`); over `fontTextMaxChars` UTF-16 units → a 400 JSON error. A missing/
    /// unknown `fontId` is a plain 404 (JS: any `renderFontText` throw collapses to a bare
    /// `new Response('Not Found', {status:404})`, matching every other font route's shape).
    static func fontTextSvg(
        _ conn: StorageConnection, fontId: String?, text: String?, size: Int?, dataDir: String
    ) -> ResponseContent {
        let resolvedText: String
        if let text, !text.isEmpty {
            guard text.utf16.count <= fontTextMaxChars else {
                return jsonError(
                    .badRequest, "text exceeds \(fontTextMaxChars) chars (got \(text.utf16.count))")
            }
            resolvedText = text
        } else {
            resolvedText = "Typography"
        }
        guard let fontId, !fontId.isEmpty, let font = conn.getAppleFontFileRecord(id: fontId) else {
            return .notFound
        }
        let rendered = renderFontTextCore(font: font, text: resolvedText, size: size, dataDir: dataDir)
        return .raw(body: Array(rendered.content.utf8), contentType: rendered.mimeType, status: .ok)
    }

    /// GET /api/fonts/file/:id. Serves the extracted font FILE directly (not a render) — 404 for
    /// an unknown id or a `file_path` outside the approved roots (`FontPathContainment`, the
    /// read-side of the sync-time containment invariant). Delegating to `.file(root:subpath:)`
    /// gets a free strong size+mtime ETag, `If-None-Match` → 304, Range/206, and chunked
    /// streaming — the engine's guarded static-file primitive, the same one backing `Static`/
    /// `File` in the DSL.
    static func fontFile(_ conn: StorageConnection, id: String, dataDir: String) -> ResponseContent {
        guard let font = conn.getAppleFontFileRecord(id: id), let path = font.filePath, !path.isEmpty,
            FontPathContainment.isContained(path, dataDir: dataDir)
        else {
            return .notFound
        }
        let resolved = URL(fileURLWithPath: path).standardizedFileURL.path
        let directory = (resolved as NSString).deletingLastPathComponent
        let baseName = (resolved as NSString).lastPathComponent
        let ext = (baseName as NSString).pathExtension.lowercased()
        var headers = HTTPFields()
        headers.setValue(
            contentDispositionAttachment(font.fileName ?? baseName), for: contentDispositionFieldName)
        return .file(
            root: directory, subpath: baseName, contentType: fontFileContentType(extension: ext),
            headers: headers)
    }

    /// GET /api/fonts/family/:id.zip?subset=. Bundles a font family into a STORE-method ZIP,
    /// persisted to `<dataDir>/resources/fonts/zips/` on first request; subsequent requests for
    /// the same (family, subset, input fingerprint) serve the cached file via `.file` (free
    /// ETag/304/Range). The hash in the cache filename keys on file name + size + mtime per
    /// source file, so a font-corpus update lands a different cache entry automatically.
    static func fontFamilyZip(
        _ conn: StorageConnection, familyId: String, subset: FontZipSubset, dataDir: String
    ) -> ResponseContent {
        guard let family = conn.listAppleFonts().first(where: { $0.id == familyId }),
            !family.files.isEmpty
        else { return .notFound }
        let filtered = family.files.filter { matchesFontSubset($0, subset) }
        guard !filtered.isEmpty else { return .notFound }

        var seenNames: Set<String> = []
        var safeFiles: [SafeFontFile] = []
        for file in filtered {
            guard seenNames.insert(file.fileName).inserted,
                let path = file.filePath, FontPathContainment.isContained(path, dataDir: dataDir),
                let stat = fontFileStat(path)
            else { continue }
            safeFiles.append(
                SafeFontFile(name: file.fileName, path: path, size: stat.size, mtime: stat.mtime))
        }
        guard !safeFiles.isEmpty else { return .notFound }

        let fingerprint = safeFiles.map { "\($0.name)|\($0.size)|\($0.mtime)" }.joined(separator: "\n")
        let hash = String(ConditionalRequest.sha256HexLower(Array(fingerprint.utf8)).prefix(16))
        let suffix = subset == .all ? "" : "-\(subset.rawValue)"
        let cacheDir = "\(dataDir)/resources/fonts/zips"
        let cacheName = "\(familyId)\(suffix)-\(hash).zip"
        let cachePath = "\(cacheDir)/\(cacheName)"

        if !FileManager.default.fileExists(atPath: cachePath) {
            var entries: [StoreZip.Entry] = []
            for file in safeFiles {
                guard let data = try? Data(contentsOf: URL(fileURLWithPath: file.path)) else { continue }
                entries.append(StoreZip.Entry(name: file.name, data: Array(data)))
            }
            guard !entries.isEmpty else { return .notFound }
            writeFontZipAtomically(StoreZip.build(entries), to: cachePath, in: cacheDir)
        }
        guard FileManager.default.fileExists(atPath: cachePath) else { return .notFound }

        var headers = HTTPFields()
        headers.setValue(
            contentDispositionAttachment("\(familyId)\(suffix).zip"), for: contentDispositionFieldName)
        return .file(root: cacheDir, subpath: cacheName, contentType: "application/zip", headers: headers)
    }

    /// GET /api/symbols/<public|private>/<name>.(svg|png). Live-renders only — no
    /// prerendered-snapshot fast path and no on-disk render cache yet (matches the
    /// `render_sf_symbol` MCP tool's own live-only behavior; the SF-Symbol prerender disk cache
    /// is a separate, not-yet-landed task). Any failure (symbol not found, cataloged-but-
    /// unsupported, or a render error) collapses to a plain 404 — JS instead renders the
    /// corpus-aware themed 404 HTML page here, a page `ad-server` doesn't have: its web surface
    /// is JSON/render endpoints only, and static HTML pages are `ad-cli web build`'s job, not
    /// `ad-server serve`'s (rfcs/0007 §11 finding #5).
    static func symbolRender(_ conn: StorageConnection, _ request: SymbolRenderRequest) -> ResponseContent {
        do {
            let outcome = try renderSfSymbolBytes(conn, request)
            switch outcome {
                case .svg(let svg):
                    return .raw(body: Array(svg.utf8), contentType: outcome.mimeType, status: .ok)
                case .png(let bytes):
                    return .raw(body: bytes, contentType: outcome.mimeType, status: .ok)
            }
        } catch {
            return .notFound
        }
    }

    /// The full `/api/symbols/<scope>/<name>.(svg|png)` request: validate the query bag
    /// (`validateSymbolRenderParams`) and either render or shape the 400. Kept separate from
    /// `symbolRender` so a caller that already holds a validated `SymbolRenderRequest` (none
    /// today, but the split mirrors the JS route's own validate-then-render structure) can skip
    /// re-validating.
    static func symbolRenderFromQuery(
        _ conn: StorageConnection, scope: String, name: String, format: String, query: [String: String]
    ) -> ResponseContent {
        switch validateSymbolRenderParams(scope: scope, name: name, format: format, query: query) {
            case .valid(let request): return symbolRender(conn, request)
            case .invalid(let message): return jsonError(.badRequest, message)
        }
    }
}

/// The outcome of `validateSymbolRenderParams` — a plain two-case enum rather than `Result`,
/// since the "invalid" payload is a plain `String` message and `String` doesn't conform to
/// `Error` (so `Result<SymbolRenderRequest, String>` doesn't typecheck).
enum SymbolParamValidation {
    case valid(SymbolRenderRequest)
    case invalid(String)
}

/// JS `FONT_TEXT_MAX_CHARS` — the `/api/fonts/text.svg` `?text=` length cap, counted in UTF-16
/// code units (matching JS `String.length`).
private let fontTextMaxChars = 256

/// JS `ALLOWED_SYMBOL_SIZES` — a `Set`, so this is its exact insertion (= ascending) order; the
/// 400 error message lists them in this order too.
private let allowedSymbolSizes: [Int] = [8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 256]

/// A `{"error": message}` JSON body at `status` — matches JS `jsonResponse({error}, {status})`.
private func jsonError(_ status: HTTPStatus, _ message: String) -> ResponseContent {
    var w = JSONStreamWriter(capacity: 128)
    w.beginObject()
    w.key("error")
    w.string(message)
    w.endObject()
    return .raw(body: w.finish(), contentType: "application/json;charset=utf-8", status: status)
}

/// The `/api/symbols/.../<name>.(svg|png)` query-param validation (JS `validateSymbolParams`,
/// render-validation.js): each PRESENT-but-invalid param is a 400 with a specific message; an
/// ABSENT param resolves to nil (the renderer's own default applies). `fg` takes priority over
/// `color` when both are given (JS: `searchParams.get('fg') ?? searchParams.get('color')`).
func validateSymbolRenderParams(
    scope: String, name: String, format: String, query: [String: String]
) -> SymbolParamValidation {
    var size: Int?
    if let raw = nonEmptyQueryValue(query["size"]) {
        guard let parsed = Int(raw), allowedSymbolSizes.contains(parsed) else {
            return .invalid("size must be one of: \(allowedSymbolSizes.map(String.init).joined(separator: ", "))")
        }
        size = parsed
    }
    let colorParam = nonEmptyQueryValue(query["fg"]) ?? nonEmptyQueryValue(query["color"])
    if let colorParam, !matchesColorQueryPattern(colorParam) {
        return .invalid("color must be a 6-character hex value (e.g. #FF8800 or FF8800)")
    }
    let backgroundParam = nonEmptyQueryValue(query["bg"])
    if let backgroundParam, !matchesColorQueryPattern(backgroundParam) {
        return .invalid("bg must be a 6-character hex value (e.g. #FF8800 or FF8800)")
    }
    var weight: String?
    if let raw = nonEmptyQueryValue(query["weight"]) {
        let lowered = raw.lowercased()
        guard SymbolWeight(rawValue: lowered) != nil else {
            return .invalid(
                "weight must be one of: \(SymbolWeight.allCases.map(\.rawValue).joined(separator: ", "))")
        }
        weight = lowered
    }
    var scale: String?
    if let raw = nonEmptyQueryValue(query["scale"]) {
        let lowered = raw.lowercased()
        guard SymbolScale(rawValue: lowered) != nil else {
            return .invalid(
                "scale must be one of: \(SymbolScale.allCases.map(\.rawValue).joined(separator: ", "))")
        }
        scale = lowered
    }
    return .valid(
        SymbolRenderRequest(
            scope: scope, name: name, format: format, size: size, color: colorParam,
            background: backgroundParam, weight: weight, scale: scale))
}

/// `/^#?[0-9A-Fa-f]{6}$/` — an optional leading `#`, then exactly 6 ASCII hex digits (JS
/// `COLOR_RE`). Distinct from `Tools.swift`'s `isHexColor` (the render-time normalizer): that one
/// REQUIRES the `#` and accepts 6-OR-8 digits. A bare `FF8800` (no `#`) passes this route-level
/// check but is silently reset to black by the deeper normalizer — exactly the two-stage
/// behavior JS's own pipeline has (this route's validator, then the renderer's own normalizer).
private func matchesColorQueryPattern(_ s: String) -> Bool {
    var bytes = Array(s.utf8)
    if bytes.first == UInt8(ascii: "#") { bytes.removeFirst() }
    guard bytes.count == 6 else { return false }
    return bytes.allSatisfy { byte in
        (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66)
    }
}

/// `value` when non-nil and non-empty, else nil — `url.searchParams.get(k)` returns `""` for a
/// bare `?k` with no `=`, and JS's validators treat that the same as absent.
private func nonEmptyQueryValue(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    return value
}

/// CSS `format(...)` hint.
private func formatHint(_ format: String?) -> String {
    switch (format ?? "").lowercased() {
        case "ttf": return "truetype"
        case "otf": return "opentype"
        case "ttc": return "collection"
        default: return ""
    }
}

/// `encodeURIComponent` — the unreserved set `A-Za-z0-9-_.!~*'()` passes through;
/// every other byte becomes `%XX` (uppercase hex) over its UTF-8 bytes.
private func encodeURIComponent(_ s: String) -> String {
    let unreserved = Set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()".utf8)
    let hex: [UInt8] = Array("0123456789ABCDEF".utf8)
    var out: [UInt8] = []
    for b in s.utf8 {
        if unreserved.contains(b) {
            out.append(b)
        } else {
            out.append(UInt8(ascii: "%"))
            out.append(hex[Int(b >> 4)])
            out.append(hex[Int(b & 0xF)])
        }
    }
    return String(decoding: out, as: UTF8.self)
}

/// Encodes a `JSONValue` to bytes (ADJSON); `null` on the impossible throw.
private func encodeJSONValue(_ value: JSONValue) -> [UInt8] {
    (try? value.encoded()).map { Array($0) } ?? Array("null".utf8)
}

/// The full `sf_symbols` row (`...row` + the 4 parsed `*_json`): every column verbatim
/// (`bitmap_only`/`render_unsupported` stay 0/1 ints), then the parsed
/// categories/keywords/aliases/availability.
private func symbolRowObject(_ row: SfSymbolRow) -> OrderedDictionary<String, JSONValue> {
    var obj: OrderedDictionary<String, JSONValue> = [:]
    obj["name"] = .string(row.name)
    obj["scope"] = .string(row.scope)
    obj["categories_json"] = strOrNull(row.categoriesJson)
    obj["keywords_json"] = strOrNull(row.keywordsJson)
    obj["aliases_json"] = strOrNull(row.aliasesJson)
    obj["availability_json"] = strOrNull(row.availabilityJson)
    obj["order_index"] = intOrNull(row.orderIndex)
    obj["bundle_path"] = strOrNull(row.bundlePath)
    obj["bundle_version"] = strOrNull(row.bundleVersion)
    obj["updated_at"] = strOrNull(row.updatedAt)
    obj["codepoint"] = intOrNull(row.codepoint)
    obj["codepoint_version"] = strOrNull(row.codepointVersion)
    obj["bitmap_only"] = intOrNull(row.bitmapOnly)
    obj["render_unsupported"] = intOrNull(row.renderUnsupported)
    obj["categories"] = parsedArray(row.categoriesJson)
    obj["keywords"] = parsedArray(row.keywordsJson)
    obj["aliases"] = parsedArray(row.aliasesJson)
    obj["availability"] = parsedValue(row.availabilityJson)
    return obj
}

private func strOrNull(_ s: String?) -> JSONValue { s.map { JSONValue.string($0) } ?? .null }
private func intOrNull(_ n: Int64?) -> JSONValue { n.map { JSONValue.number(Double($0)) } ?? .null }

/// parseJsonArray: the parsed value if it's an array, else `[]`.
private func parsedArray(_ json: String?) -> JSONValue {
    guard let json, let v = try? JSONValue(parsing: json), case .array = v else { return .array([]) }
    return v
}

/// parseJsonValue: the parsed value, or `null`.
private func parsedValue(_ json: String?) -> JSONValue {
    guard let json, let v = try? JSONValue(parsing: json) else { return .null }
    return v
}

/// `U+XXXX` display form (`codepoint.toString(16).toUpperCase().padStart(4,'0')`).
private func codepointDisplay(_ cp: Int64) -> String {
    let hex = String(cp, radix: 16, uppercase: true)
    let padded = hex.count < 4 ? String(repeating: "0", count: 4 - hex.count) + hex : hex
    return "U+\(padded)"
}

/// Matches `^/api/symbols/(public|private)/(.+)\.json$` → (scope, decoded name).
func matchSymbolMetadataPath(_ path: Substring) -> (scope: String, name: String)? {
    for scope in ["public", "private"] {
        let prefix = "/api/symbols/\(scope)/"
        guard path.hasPrefix(prefix), path.hasSuffix(".json") else { continue }
        let nameStart = path.index(path.startIndex, offsetBy: prefix.count)
        let nameEnd = path.index(path.endIndex, offsetBy: -5)
        guard nameStart < nameEnd else { continue }
        guard let name = percentDecode(String(path[nameStart ..< nameEnd])) else { return nil }
        return (scope, name)
    }
    return nil
}

/// Matches `^/api/symbols/(public|private)/(.+)\.(svg|png)$` → (scope, decoded name, format).
func matchSymbolRenderPath(_ path: Substring) -> (scope: String, name: String, format: String)? {
    for scope in ["public", "private"] {
        let prefix = "/api/symbols/\(scope)/"
        guard path.hasPrefix(prefix) else { continue }
        for format in ["svg", "png"] {
            let suffix = ".\(format)"
            guard path.hasSuffix(suffix) else { continue }
            let nameStart = path.index(path.startIndex, offsetBy: prefix.count)
            let nameEnd = path.index(path.endIndex, offsetBy: -suffix.count)
            guard nameStart < nameEnd else { continue }
            guard let name = percentDecode(String(path[nameStart ..< nameEnd])) else { return nil }
            return (scope, name, format)
        }
    }
    return nil
}

/// Matches `^/api/fonts/family/([^/]+)\.zip$` → the decoded family id.
func matchFontFamilyZipPath(_ path: Substring) -> String? {
    let prefix = "/api/fonts/family/"
    let suffix = ".zip"
    guard path.hasPrefix(prefix), path.hasSuffix(suffix) else { return nil }
    let start = path.index(path.startIndex, offsetBy: prefix.count)
    let end = path.index(path.endIndex, offsetBy: -suffix.count)
    guard start < end else { return nil }
    let middle = path[start ..< end]
    guard !middle.contains("/") else { return nil }
    return percentDecode(String(middle))
}

private func titleIndexResponse(_ ti: TitleIndex) -> TitleIndexResponse {
    TitleIndexResponse(
        v: 2, frameworks: ti.frameworks, keys: ti.keys, titles: ti.titles, abstracts: ti.abstracts,
        fwIndices: ti.fwIndices, kinds: ti.kinds, roleHeadings: ti.roleHeadings)
}

/// Matches `^/data/search/(title-index|aliases)\.[0-9a-f]{10}\.json$` → the base
/// name. The <hash> is cache-busting only — the route serves the CURRENT artifact.
func matchHashedSearchArtifact(_ path: Substring) -> String? {
    for base in ["title-index", "aliases"] {
        let prefix = "/data/search/\(base)."
        guard path.hasPrefix(prefix), path.hasSuffix(".json") else { continue }
        let hashStart = path.index(path.startIndex, offsetBy: prefix.count)
        let hashEnd = path.index(path.endIndex, offsetBy: -5)
        let hash = path[hashStart ..< hashEnd]
        guard hash.count == 10,
            hash.allSatisfy({ ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f") })
        else { continue }
        return base
    }
    return nil
}

/// Canonical web path for a corpus key — oversized path segments get the
/// deterministic truncate-and-hash treatment so the live server and the static
/// build emit the IDENTICAL `/docs/<key>/` URL. See `ADBase.SafePath`.
private func safeWebDocKey(_ key: String) -> String { SafePath.safeWebDocKey(key) }

/// Matches `^/data/frameworks/([^/]+)/tree\.([0-9a-f]{10})\.json$` → the slug.
func matchFrameworkTreePath(_ path: Substring) -> String? {
    let prefix = "/data/frameworks/"
    guard path.hasPrefix(prefix), path.hasSuffix(".json") else { return nil }
    let middle = path[
        path.index(path.startIndex, offsetBy: prefix.count) ..< path.index(path.endIndex, offsetBy: -5)]
    guard let r = middle.range(of: "/tree.") else { return nil }
    let slug = middle[..<r.lowerBound]
    let hash = middle[r.upperBound...]
    guard !slug.isEmpty, !slug.contains("/"), hash.count == 10,
        hash.allSatisfy({ ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f") })
    else { return nil }
    return String(slug)
}
