// Shared SF-Symbol render core for the HTTP `/api/symbols/<scope>/<name>.(svg|png)` route
// (WebRoutes.swift). It calls the SAME ADRender APIs `render_sf_symbol` (Tools.swift) and the
// `sf-symbol` MCP resource (Resources.swift) already use — `SymbolPdf.render` →
// `SymbolPdfToSvg.convert` for svg, `SymbolPng.render` for png — so the actual rendering (PDF
// generation, the luminance-mask SVG compositor, the AppKit rasterizer) is never re-implemented,
// only called a third time.
//
// Deliberately NOT wired into the existing `render_sf_symbol` tool handler or the `sf-symbol`
// resource: the tool's PNG branch is parity-gated (`tools/call render_sf_symbol == oracle`, svg
// only) and today never rasterizes PNG bytes at all — it only returns a resource URI. Routing it
// through this function would start eagerly rendering PNG on every tool call, a behavior change
// outside this task's scope. Both existing call sites are left byte-for-byte untouched; this is
// a third, independent caller of the same ADRender primitives, reusing Tools.swift's
// `normalizeSymbolColor` / `normalizeSymbolBackground` / `clampInteger` helpers.

import ADRender
import ADStorage

/// The `/api/symbols/<scope>/<name>.(svg|png)` request, pre-validated by the caller (the HTTP
/// route's own size/color/weight/scale checks — see `WebRoutes.validateSymbolRenderParams`).
/// Bundled into one type so `renderSfSymbolBytes` stays under the project's parameter-count gate
/// (the same reason `ADRender.SymbolPng.SymbolStyle` bundles weight+scale).
struct SymbolRenderRequest: Sendable {
    let scope: String
    let name: String
    let format: String
    let size: Int?
    let color: String?
    let background: String?
    let weight: String?
    let scale: String?
}

/// A completed SF Symbol render: either SVG markup or PNG bytes (never both — the caller picks
/// the branch via `request.format`).
enum SymbolRenderOutcome: Sendable {
    case svg(String)
    case png([UInt8])

    var mimeType: String {
        switch self {
            case .svg: return "image/svg+xml; charset=utf-8"
            case .png: return "image/png"
        }
    }
}

/// Why a render didn't produce an outcome — the HTTP route maps every case to a 404 (JS's
/// `symbolRenderHandler` treats all three identically: a catch-all 404/themed-not-found page).
enum SymbolRenderCoreError: Error, Sendable {
    case notFound
    case unsupported
    case renderFailed
}

/// The `renderSfSymbol` (apple-symbols/render.js) live-render core: resolve the symbol, apply
/// the same scope/weight/scale/color/background defaulting the MCP tool + resource use, then
/// render via ADRender. `request`'s fields arrive pre-validated (legal enum/hex/size values); this
/// only fills in the per-scope defaults and normalizes color/background exactly as the JS
/// renderer does.
func renderSfSymbolBytes(
    _ conn: StorageConnection, _ request: SymbolRenderRequest
) throws(SymbolRenderCoreError) -> SymbolRenderOutcome {
    #if canImport(AppKit)
        let pointSize = clampInteger(request.size ?? 64, min: 8, max: 1024)
        let isPublic = request.scope == "public"
        let weight = isPublic ? (request.weight ?? "regular") : "regular"
        let scale = isPublic ? (request.scale ?? "medium") : "medium"
        let rawColor = request.color ?? "#000000"
        let color =
            (request.format == "svg" && rawColor.lowercased() == "currentcolor")
            ? "currentColor" : normalizeSymbolColor(rawColor)
        let background = normalizeSymbolBackground(request.background)

        guard let symbol = conn.getSfSymbol(scope: request.scope, name: request.name) else {
            throw .notFound
        }
        if let unsupported = symbol.renderUnsupported, unsupported != 0 {
            throw .unsupported
        }

        if request.format == "svg" {
            guard let pdf = SymbolPdf.render(name: request.name, scope: request.scope, weight: weight, scale: scale)
            else { throw .renderFailed }
            guard
                let svg = try? SymbolPdfToSvg.convert(
                    pdf, options: .init(name: request.name, pointSize: pointSize, color: color, background: background))
            else { throw .renderFailed }
            return .svg(svg)
        }
        guard
            let png = SymbolPng.render(
                name: request.name, scope: request.scope, pointSize: Double(pointSize), color: color,
                background: background, style: .init(weight: weight, scale: scale))
        else { throw .renderFailed }
        return .png(png)
    #else
        throw .renderFailed
    #endif
}
