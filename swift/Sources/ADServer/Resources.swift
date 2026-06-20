// The ad-server MCP resource surface (RFC 0005 D2). Mirrors the JS resource
// registrations in src/mcp/server/resources.js. All four are wired: `framework`
// (reuses the byte-proven browse shaping), `doc` (the shared on-demand Markdown
// render), `font` (the indexed font file → base64 blob), and `sf-symbol` (the
// byte-verified SymbolPdfToSvg converter for svg; ADRender's rasterizer → base64
// for png). The dynamic `resources/list` enumerates only the `framework` roots
// (the only JS template with a list callback).

import ADJSON
import ADRender
import ADServeCore
import ADStorage
import Foundation

/// The app's `MCPResourceProviding`, handed to the dispatcher alongside the tools.
func mcpResourceRegistry() -> ResourceRegistry { ResourceRegistry() }

struct ResourceRegistry: MCPResourceProviding {
    /// `resources/list` — only the `framework` resource is enumerable (the JS
    /// `framework` template's list callback); it maps the framework roots, exactly
    /// like `projectFrameworks(...).roots`, to `apple-docs://framework/<slug>`.
    func listResources(context: MCPToolContext) -> [MCPResourceListItem] {
        context.db.listFrameworkRoots(kind: nil)
            .map {
                MCPResourceListItem(uri: "apple-docs://framework/\($0.slug)", name: $0.name)
            }
    }

    func readResource(uri: String, context: MCPToolContext) -> MCPResourceResult {
        if let key = docKey(uri) {
            return .contents([
                MCPResourceContent(uri: uri, text: docResourceText(context.db, key), mimeType: "text/markdown")
            ])
        }
        if let slug = frameworkSlug(uri) {
            guard let value = frameworkResourceValue(context.db, slug) else { return .notFound(uri) }
            let bytes = (try? value.encoded()).map(Array.init) ?? Array("null".utf8)
            return .contents([
                MCPResourceContent(uri: uri, text: String(decoding: bytes, as: UTF8.self), mimeType: "application/json")
            ])
        }
        if let id = fontId(uri) {
            return fontResource(context.db, uri: uri, id: id)
        }
        if isSfSymbolResource(uri) { return sfSymbolResource(context.db, uri: uri) }
        return .notFound(uri)
    }
}

/// `apple-docs://font/{id}` → id (query stripped; `{id}` is a single segment, so
/// no slashes); nil for any other URI.
private func fontId(_ uri: String) -> String? {
    let prefix = "apple-docs://font/"
    guard uri.hasPrefix(prefix) else { return nil }
    let rest = uri.dropFirst(prefix.count)
    let id = rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    return id.isEmpty ? nil : id
}

/// The JS `font` resource: read the indexed file off disk → base64 blob, with
/// mimeType font/ttf | font/otf | application/octet-stream by `format`.
/// NotFoundError (→ -32002) when the id is unknown OR the file is missing on
/// disk. The path is the absolute `file_path` column (no dataDir needed); the
/// JS font resource applies no path-safety wrapper (unlike render_font_text), so
/// this is byte-faithful. Foundation base64 == Node `Buffer.toString('base64')`.
private func fontResource(_ conn: StorageConnection, uri: String, id: String) -> MCPResourceResult {
    guard let record = conn.getAppleFontFileRecord(id: id), let path = record.filePath else {
        return .notFound(uri)
    }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return .notFound(uri) }
    let mimeType =
        record.format == "ttf"
        ? "font/ttf" : record.format == "otf" ? "font/otf" : "application/octet-stream"
    return .contents([
        MCPResourceContent(uri: uri, blob: data.base64EncodedString(), mimeType: mimeType)
    ])
}

/// True for an `apple-docs://sf-symbol/…` URI (recognized so the read returns a
/// deliberate -32002, documented at the call site).
private func isSfSymbolResource(_ uri: String) -> Bool {
    uri.hasPrefix("apple-docs://sf-symbol/")
}

/// The JS `sf-symbol` resource: render the symbol from the URI path + query
/// params, mirroring renderSfSymbol. svg → inline text (the byte-verified
/// converter, same path as the render_sf_symbol tool); png → base64 blob via
/// ADRender's rasterizer. Not covered by a parity gate (inspection-faithful to the
/// JS shape + mime types).
private func sfSymbolResource(_ conn: StorageConnection, uri: String) -> MCPResourceResult {
    guard let p = parseSfSymbolUri(uri) else { return .notFound(uri) }
    let format = p.format == "svg" ? "svg" : "png"
    let isPublic = p.scope == "public"
    let pointSize = min(max(p.query["size"].flatMap { Int($0) } ?? 64, 8), 1024)
    let weight =
        isPublic ? (SymbolWeight(rawValue: (p.query["weight"] ?? "").lowercased())?.rawValue ?? "regular") : "regular"
    let scale =
        isPublic ? (SymbolScale(rawValue: (p.query["scale"] ?? "").lowercased())?.rawValue ?? "medium") : "medium"
    let rawColor = p.query["color"] ?? p.query["fg"] ?? "#000000"
    let color =
        (format == "svg" && rawColor.lowercased() == "currentcolor") ? "currentColor" : sfNormalizeColor(rawColor)
    let background = sfNormalizeBackground(p.query["background"] ?? p.query["bg"])

    guard let symbol = conn.getSfSymbol(scope: p.scope, name: p.name) else { return .notFound(uri) }
    if let unsupported = symbol.renderUnsupported, unsupported != 0 { return .notFound(uri) }

    if format == "svg" {
        guard let pdf = SymbolPdf.render(name: p.name, scope: p.scope, weight: weight, scale: scale),
            let svg = try? SymbolPdfToSvg.convert(
                pdf, options: .init(name: p.name, pointSize: pointSize, color: color, background: background))
        else { return .notFound(uri) }
        return .contents([MCPResourceContent(uri: uri, text: svg, mimeType: "image/svg+xml; charset=utf-8")])
    }
    guard
        let png = SymbolPng.render(
            name: p.name, scope: p.scope, pointSize: Double(pointSize), color: color, background: background,
            style: .init(weight: weight, scale: scale))
    else { return .notFound(uri) }
    return .contents([MCPResourceContent(uri: uri, blob: Data(png).base64EncodedString(), mimeType: "image/png")])
}

/// `apple-docs://sf-symbol/{scope}/{name}.{format}?query` → its parts. `name` is
/// percent-decoded (JS decodeURIComponent); `format` is the final extension.
private struct SfSymbolURI {
    let scope: String
    let name: String
    let format: String
    let query: [String: String]
}

private func parseSfSymbolUri(_ uri: String) -> SfSymbolURI? {
    let prefix = "apple-docs://sf-symbol/"
    guard uri.hasPrefix(prefix) else { return nil }
    let rest = String(uri.dropFirst(prefix.count))
    let pathPart: String
    let queryPart: String
    if let q = rest.firstIndex(of: "?") {
        pathPart = String(rest[..<q])
        queryPart = String(rest[rest.index(after: q)...])
    } else {
        pathPart = rest
        queryPart = ""
    }
    guard let slash = pathPart.firstIndex(of: "/") else { return nil }
    let scope = String(pathPart[..<slash])
    let nameDotFormat = String(pathPart[pathPart.index(after: slash)...])
    guard !scope.isEmpty, let dot = nameDotFormat.lastIndex(of: ".") else { return nil }
    let encodedName = String(nameDotFormat[..<dot])
    let name = encodedName.removingPercentEncoding ?? encodedName
    let format = String(nameDotFormat[nameDotFormat.index(after: dot)...])
    guard !name.isEmpty, !format.isEmpty else { return nil }
    return SfSymbolURI(scope: scope, name: name, format: format, query: sfParseQuery(queryPart))
}

private func sfParseQuery(_ s: String) -> [String: String] {
    var out: [String: String] = [:]
    for pair in s.split(separator: "&", omittingEmptySubsequences: true) {
        let kv = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
        let key = String(kv[0])
        guard !key.isEmpty else { continue }
        let value = kv.count > 1 ? (String(kv[1]).removingPercentEncoding ?? String(kv[1])) : ""
        out[key] = value
    }
    return out
}

/// normalizeColor: a trimmed `#RRGGBB(AA)` hex → raw; else `#000000`.
private func sfNormalizeColor(_ value: String) -> String {
    let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return sfIsHexColor(raw) ? raw : "#000000"
}
private func sfNormalizeBackground(_ value: String?) -> String? {
    guard let value else { return nil }
    let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if raw.isEmpty || raw == "transparent" || raw == "none" { return nil }
    return sfIsHexColor(raw) ? raw : nil
}
private func sfIsHexColor(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count == 7 || u.count == 9, u[0] == 0x23 else { return false }
    for b in u[1...] where !((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)) {
        return false
    }
    return true
}

/// `apple-docs://doc/{+key}` → key (reserved expansion: keeps slashes; query
/// stripped); nil for any other URI.
private func docKey(_ uri: String) -> String? {
    let prefix = "apple-docs://doc/"
    guard uri.hasPrefix(prefix) else { return nil }
    let rest = uri.dropFirst(prefix.count)
    let key = rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    return key.isEmpty ? nil : key
}

/// The JS doc resource body: `found===false ? (note ?? "Not found") : (content
/// ?? note ?? "Not found")`. A found page with renderable sections returns the
/// on-demand Markdown render (shared with read_doc via `renderDocMarkdown`, so
/// the bytes match `lookup`'s `content`); otherwise its tier-aware no-content
/// note. Resolution mirrors lookup: the raw key, then a normalize-identifier
/// retry.
private func docResourceText(_ conn: StorageConnection, _ key: String) -> String {
    var record = conn.readDocument(key)
    if record == nil, let normalized = normalizeIdentifier(key), normalized != key {
        record = conn.readDocument(normalized)
    }
    guard let page = record else { return "Not found" }

    let sections = conn.documentSections(page.path)
    if !sections.isEmpty {
        return renderDocMarkdown(page, sections)
    }
    return conn.snapshotTier() == "lite"
        ? "Content body unavailable on a legacy lite-tier snapshot. Metadata and declaration shown."
        : "No content available. Run apple-docs sync first."
}

/// `apple-docs://framework/{slug}` → slug (query stripped); nil for any other URI.
private func frameworkSlug(_ uri: String) -> String? {
    let prefix = "apple-docs://framework/"
    guard uri.hasPrefix(prefix) else { return nil }
    let rest = uri.dropFirst(prefix.count)
    let slug = rest.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
    return slug.isEmpty ? nil : slug
}

/// `serializePayload(projectBrowse(browse({framework: slug})))` — unbounded, since
/// the resource passes no limit. wwdc → per-year groups; everything else → all pages.
private func frameworkResourceValue(_ conn: StorageConnection, _ slug: String) -> JSONValue? {
    guard let root = conn.resolveRoot(slug) else { return nil }
    let allPages = conn.pagesByRoot(root.slug)

    if root.sourceType == "wwdc" {
        var counts: [Int: Int] = [:]
        for page in allPages {
            if let year = wwdcYear(page.path) { counts[year, default: 0] += 1 }
        }
        let groups = counts.keys.sorted(by: >)
            .map { year in
                // Integer-shaped fields use `.int` so they encode as `2`, not `2.0`
                // — the resource text is byte-compared to JSON.stringify (unlike the
                // browse tool, whose structuredContent is only compared parsed).
                JSONValue.object(["year": .int(Int64(year)), "count": .int(Int64(counts[year]!))])
            }
        return .object([
            "framework": .string(root.displayName), "groups": .array(groups),
            "total": .int(Int64(allPages.count))
        ])
    }

    let pages = allPages.map { page in
        JSONValue.object([
            "path": .string(page.path),
            "title": page.title.map(JSONValue.string) ?? .null,
            "kind": (page.roleHeading ?? page.role).map(JSONValue.string) ?? .null,
            "abstract": page.abstract.map(JSONValue.string) ?? .null
        ])
    }
    return .object([
        "framework": .string(root.displayName), "pages": .array(pages),
        "total": .int(Int64(allPages.count))
    ])
}

/// `/^wwdc\/wwdc(\d{4})-/` → the 4-digit year (mirrors Tools.swift's helper).
private func wwdcYear(_ path: String) -> Int? {
    let prefix = "wwdc/wwdc"
    guard path.hasPrefix(prefix) else { return nil }
    let rest = path.dropFirst(prefix.count)
    let digits = rest.prefix(4)
    guard digits.count == 4, digits.allSatisfy(\.isNumber), rest.dropFirst(4).first == "-" else { return nil }
    return Int(digits)
}
