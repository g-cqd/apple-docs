// render_font_text / render_sf_symbol — split from Tools.swift to keep that
// file within the size gate (ADBuildTools' canonical `.swiftlint.yml`, file_length
// warning 500 / error 800, enforced via `swiftlint --strict`).

import ADContent
import ADFCore
import ADJSON
import ADRender
// `MCPToolContext`/`MCPToolResult` are `ADMCP` types, re-exported (`@_exported
// import ADMCP`) by `ADServeCore/MCPReExport.swift` — `MemberImportVisibility`
// requires importing that carrier directly in every file that names them.
import ADServeCore
import ADStorage
import Foundation

// MARK: - render_font_text
//
// Byte-faithful port of apple-assets.js `renderFontText` + `projectRenderFontText`
// for the surface the in-process (`--db`-only) server can actually reproduce.
//
// The JS render: getAppleFontFile(fontId) → text=String(text ?? "Typography"),
// pointSize=clamp(size ?? 96, 8, 512) → assertFontPathContained(file_path,
// dataDir) (else placeholder SVG) → isLikelySfnt probe → engine chain (darwin:
// CoreText, then hb-native, then hb-view; non-darwin: hb-native, then hb-view) →
// placeholder on failure. Result projects to `{ text, mimeType, content }` (font
// + format dropped).
//
// Engine chain — matches JS's `_resolveFontTextEngines` order exactly, first
// non-nil result wins: CoreText (`FontText.renderSVG`, darwin-only) → hb-native
// (`ADRender.HarfBuzzShaper.renderSVG`, the dlopen'd in-process HarfBuzz shim) →
// hb-view (`ADRender.HbViewRenderer.renderSVG`, spawns the system `hb-view` CLI
// when installed).
//
// One honest remaining deviation from the JS oracle, forced by the server having
// no CLI-flag dataDir (MCPCommand opens only --db; `MCPToolContext` carries just
// (connection, logger), so an explicit `--home` override on THIS process isn't
// visible here): path-safety. The JS allowlist roots are /Library/Fonts,
// /System/Library/Fonts, ~/Library/Fonts AND <dataDir>/resources/fonts/extracted.
// The first three are dataDir-independent and checked identically; the 4th is now
// ALSO checked, with dataDir resolved the same way `CorpusOptions.path` resolves
// the corpus home (`$APPLE_DOCS_HOME`, else `~/.apple-docs`) — covering the
// default and env-var configurations every stdio MCP client uses in practice. The
// one narrower gap: a bare `--home /custom/path` CLI flag with no matching
// `$APPLE_DOCS_HOME` still resolves to the default here, so a font that lives
// ONLY under that custom home's `.../extracted` would (incorrectly) hit the
// placeholder. Reported, not hidden; System/home-root fonts, the default/env-var
// dataDir case, and off-root paths all match the JS oracle exactly.

func renderFontText(_ input: RenderFontTextInput, _ ctx: MCPToolContext) -> MCPToolResult {
    // The zod `size` bound (8-512) rejects out-of-range input at decode time; check it
    // FIRST here too, before any lookup runs, to match that order.
    if let error = validateBound(input.size, 8 ... 512, field: "size") { return .failure(error) }
    // getAppleFontFile(fontId) — a missing row is a not-found (JS NotFoundError →
    // the dispatcher's isError result, which the parity oracle's try/catch maps to
    // a self-skip).
    guard let font = ctx.db.getAppleFontFileRecord(id: input.fontId) else {
        return .failure("Font file not found: \(input.fontId)")
    }
    let text = input.text ?? "Typography"
    // dataDir: nil — MCPToolContext carries only a connection + logger (MCPCommand opens just
    // --db), so only the 3 dataDir-independent system roots are checked; see
    // `renderFontTextCore`'s own doc for the HTTP route's wider check.
    let rendered = renderFontTextCore(font: font, text: text, size: input.size, dataDir: nil)
    // projectRenderFontText: { text, mimeType, content } in that key order.
    return .okValue(
        .object([
            "text": .string(rendered.text),
            "mimeType": .string(rendered.mimeType),
            "content": .string(rendered.content)
        ]))
}

/// The result of `renderFontTextCore` — `{ text, mimeType, content }`, matching the JS
/// `projectRenderFontText` projection the MCP tool returns.
struct FontTextRender: Sendable {
    let text: String
    let mimeType: String
    let content: String
}

/// The shared `render_font_text` core: clamps `pointSize`, then renders via the CoreText →
/// hb-native → hb-view engine chain when the font's path passes containment + looks like a
/// real SFNT font, else falls back to the placeholder SVG. Shared by the MCP `render_font_text`
/// tool above (`dataDir: nil`, already `validateBound`-checked so the clamp below is a no-op in
/// practice) and the HTTP `/api/fonts/text.svg` route (`dataDir` from `--home`/
/// `$APPLE_DOCS_HOME`, unvalidated query input — the clamp is load-bearing there).
func renderFontTextCore(font: AppleFontFileRecord, text: String, size: Int?, dataDir: String?) -> FontTextRender {
    let pointSize = clampInteger(size ?? 96, min: 8, max: 512)
    let family = font.familyDisplayName ?? ""

    let content =
        renderFontTextEngineChain(font: font, text: text, pointSize: pointSize, dataDir: dataDir)
        ?? fontTextSvgFallback(fontFamily: family, text: text, pointSize: pointSize)
    return FontTextRender(text: text, mimeType: "image/svg+xml; charset=utf-8", content: content)
}

/// The CoreText → hb-native → hb-view engine chain over `font`'s file, or nil
/// when the path fails containment/SFNT validation or every engine fails —
/// the caller falls back to the placeholder SVG exactly as JS does. `dataDir`
/// threads through to `FontPathContainment.isContained` (nil from the MCP tool,
/// the resolved `--home`/`$APPLE_DOCS_HOME` from the HTTP route).
private func renderFontTextEngineChain(
    font: AppleFontFileRecord, text: String, pointSize: Int, dataDir: String?
) -> String? {
    guard let path = font.filePath, FontPathContainment.isContained(path, dataDir: dataDir),
        isLikelySfnt(path)
    else { return nil }
    #if canImport(CoreText)
        if let svg = FontText.renderSVG(fontPath: path, text: text, pointSize: Double(pointSize)) {
            return svg
        }
    #endif
    if let bytes = HarfBuzzShaper.renderSVG(fontPath: path, text: text, pointSize: Double(pointSize)) {
        return String(decoding: bytes, as: UTF8.self)
    }
    return HbViewRenderer.renderSVG(fontPath: path, text: text, pointSize: Double(pointSize))
}

/// renderSfSymbol (apple-symbols/render.js) live path: resolve the symbol, render
/// its PDF via ADRender, and convert to SVG (SymbolPdfToSvg). The in-process server
/// has no dataDir/cache/snapshot layer, so this is the live render only; PNG bytes
/// are fetched via the returned resource URI (not inlined). projectRenderSfSymbol
/// drops file_path + (for png) svg → { name, scope, format, resourceUri, svg? }.
func renderSfSymbol(_ input: RenderSfSymbolInput, _ ctx: MCPToolContext) -> MCPToolResult {
    // SF Symbol PDF→SVG rasterization needs AppKit/CoreGraphics — Darwin only.
    #if canImport(AppKit)
        if let error = validateBound(input.size, 8 ... 1024, field: "size") { return .failure(error) }
        let scope = input.scope ?? .public
        let format = input.format ?? .png
        let pointSize = input.size ?? 64
        // weight/scale arrive pre-validated from the schema enum; public-only.
        let weight = scope == .public ? (input.weight?.rawValue ?? "regular") : "regular"
        let scale = scope == .public ? (input.scale?.rawValue ?? "medium") : "medium"
        let rawColor = input.color ?? "#000000"
        let color =
            (format == .svg && rawColor.lowercased() == "currentcolor")
            ? "currentColor" : normalizeSymbolColor(rawColor)
        let background = normalizeSymbolBackground(input.background)

        guard let symbol = ctx.db.getSfSymbol(scope: scope.rawValue, name: input.name) else {
            return .failure("SF Symbol not found: \(scope.rawValue)/\(input.name)")
        }
        if let unsupported = symbol.renderUnsupported, unsupported != 0 {
            return .failure(
                "SF Symbol \(scope.rawValue)/\(input.name) is cataloged but not renderable from this snapshot — its glyph ships with a newer macOS than the build host. Beta snapshots built on that macOS carry it (apple-docs setup --beta)."
            )
        }

        let resourceUri =
            "apple-docs://sf-symbol/\(scope.rawValue)/\(encodeURIComponentJS(input.name)).\(format.rawValue)"
        var out: OrderedDictionary<String, JSONValue> = [
            "name": .string(input.name), "scope": .string(scope.rawValue),
            "format": .string(format.rawValue), "resourceUri": .string(resourceUri)
        ]
        if format == .svg {
            guard let pdf = SymbolPdf.render(name: input.name, scope: scope.rawValue, weight: weight, scale: scale)
            else {
                return .failure("SF Symbol render failed: \(scope.rawValue)/\(input.name)")
            }
            let svg: String
            do {
                svg = try SymbolPdfToSvg.convert(
                    pdf, options: .init(name: input.name, pointSize: pointSize, color: color, background: background))
            } catch {
                return .failure("SF Symbol SVG conversion failed for \(scope.rawValue)/\(input.name): \(error)")
            }
            out["svg"] = .string(svg)
        }
        return .okValue(.object(out))
    #else
        return .failure("SF Symbol rendering needs AppKit/CoreGraphics — unavailable on this platform.")
    #endif
}

/// normalizeColor (apple-assets-helpers.js): a trimmed `#RRGGBB(AA)` hex
/// (case-insensitive) passes through; anything else → `#000000`. Shared with the HTTP
/// `/api/symbols/<scope>/<name>.(svg|png)` route (`renderSfSymbolBytes`, RenderShared.swift).
func normalizeSymbolColor(_ value: String?) -> String {
    let raw = (value ?? "#000000").trimmingCharacters(in: .whitespacesAndNewlines)
    return isHexColor(raw) ? raw : "#000000"
}

/// normalizeBackground: nil/empty/`transparent`/`none` → nil; `#RRGGBB(AA)` → raw; else nil.
/// Shared with the HTTP symbol-render route (see `normalizeSymbolColor`).
func normalizeSymbolBackground(_ value: String?) -> String? {
    guard let value else { return nil }
    let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if raw.isEmpty || raw == "transparent" || raw == "none" { return nil }
    return isHexColor(raw) ? raw : nil
}

/// JS `/^#[0-9a-f]{6}([0-9a-f]{2})?$/i`.
private func isHexColor(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count == 7 || u.count == 9, u[0] == 0x23 else { return false }
    for b in u[1...] {
        let hex = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
        if !hex { return false }
    }
    return true
}

/// `encodeURIComponent`: percent-encode every byte except the JS unreserved set
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
private func encodeURIComponentJS(_ s: String) -> String {
    let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()".utf8)
    var out = ""
    for b in s.utf8 {
        if unreserved.contains(b) {
            out.unicodeScalars.append(Unicode.Scalar(b))
        } else {
            out += String(format: "%%%02X", b)
        }
    }
    return out
}

/// `clampInteger(value, min, max)` — JS `Math.min(Math.max(parseInt(value), min),
/// max)`, NaN → min. Still needed here: `renderFontTextCore` is shared with the HTTP
/// `/api/fonts/text.svg` route, whose `?size=` query param has no upfront schema
/// validation the way the MCP tool's `validateBound` gives it.
func clampInteger(_ value: Int, min lo: Int, max hi: Int) -> Int {
    min(max(value, lo), hi)
}

/// `isLikelySfnt(path)` — reads the 4-byte magic: OTTO/ttcf/wOFF/wOF2, or the
/// 0x00010000 TrueType version. Any read failure → false.
private func isLikelySfnt(_ path: String) -> Bool {
    guard let handle = FileHandle(forReadingAtPath: path) else { return false }
    defer { try? handle.close() }
    guard let head = try? handle.read(upToCount: 4), head.count == 4 else { return false }
    let bytes = [UInt8](head)
    if let tag = String(bytes: bytes, encoding: .ascii),
        tag == "OTTO" || tag == "ttcf" || tag == "wOFF" || tag == "wOF2"
    {
        return true
    }
    return bytes == [0x00, 0x01, 0x00, 0x00]
}

/// `renderFontTextSvgFallback` from apple-fonts/render.js, character-for-
/// character: a `<text>` placeholder sized from the text length + point size.
private func fontTextSvgFallback(fontFamily: String, text: String, pointSize: Int) -> String {
    let height = Int((Double(pointSize) * 1.6).rounded(.up))
    // JS `text.length` is the UTF-16 code-unit count, not grapheme count.
    let width = max(240, Int((Double(text.utf16.count) * Double(pointSize) * 0.62).rounded(.up)))
    let baseline = Int((Double(pointSize) * 1.1).rounded(.up))
    let label = xmlEscaped(text)
    return """
        <?xml version="1.0" encoding="UTF-8"?>
        <svg xmlns="http://www.w3.org/2000/svg" width="\(width)" height="\(height)" viewBox="0 0 \(width) \(height)" role="img" aria-label="\(label)">
          <text x="0" y="\(baseline)" font-family="\(xmlEscaped(fontFamily))" font-size="\(pointSize)" fill="black">\(label)</text>
        </svg>
        """
}

/// XML/SVG attribute & text escape — the five XML 1.0 predefined entities (`& < > " '`), now via the
/// shared `ADFCore.XMLEscape` (byte-identical to the prior `replacingOccurrences` chain).
private func xmlEscaped(_ value: String) -> String { XMLEscape.escaped(value) }
