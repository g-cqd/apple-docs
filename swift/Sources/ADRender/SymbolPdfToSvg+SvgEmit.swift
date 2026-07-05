// SvgEmit (svg-emit.js) — the luminance-mask compositor stage of the SF-Symbol
// PDF→SVG converter. Independent of the byte-scan helpers (`PdfScan`): it only
// consumes the parsed `Fill` list and produces the final SVG string, so its sole
// dependency is `ADFCore.XMLEscape`.

import ADFCore
import Foundation

// MARK: - SvgEmit (svg-emit.js)

/// Compose the parsed fills into a luminance-mask SVG mirroring Apple's
/// destination-out compositing (alpha-0 fills carve earlier layers via `<mask>`).
/// Byte-for-byte equal to `assembleSvg` — same number formatting, FNV-1a mask ids,
/// attribute order, and whitespace.
enum SvgEmit {
    static func assemble(_ fills: [Fill], options: SymbolPdfToSvg.Options) throws -> String {
        var minX = Double.infinity
        var maxX = -Double.infinity
        var minY = Double.infinity
        var maxY = -Double.infinity
        for fill in fills {
            for sub in fill.subpaths {
                for cmd in sub.commands {
                    if cmd.args.isEmpty { continue }  // JS `if (!cmd.args) continue` (Z has none)
                    var i = 0
                    while i < cmd.args.count {
                        let x = cmd.args[i]
                        if x < minX { minX = x }
                        if x > maxX { maxX = x }
                        if i + 1 < cmd.args.count {
                            let y = cmd.args[i + 1]
                            if y < minY { minY = y }
                            if y > maxY { maxY = y }
                        }
                        i += 2
                    }
                }
            }
        }
        if !minX.isFinite { throw SymbolPdfParseError("symbol PDF: empty geometry") }
        let spanRaw = max(maxX - minX, maxY - minY)
        let span = spanRaw == 0 ? 1 : spanRaw
        let pad = span * 0.06
        func flipY(_ y: Double) -> Double { maxY - y + pad }
        func flipX(_ x: Double) -> Double { x - minX + pad }
        let vbW = maxX - minX + pad * 2
        let vbH = maxY - minY + pad * 2

        let fillColor = options.color
        let escapedName = escapeXml(options.name)
        let ds = fills.map { subpathsToD($0.subpaths, flipX, flipY) }
        let idBase =
            "c" + fnv1a("\(options.name)|\(jsNumberString(vbW))x\(jsNumberString(vbH))|\(ds.joined(separator: "|"))")
        var defs = ""
        var nodes: [String] = []
        for (idx, fill) in fills.enumerated() {
            if fill.alpha > 0 {
                let ruleAttr = fillRuleAttr(fill.fillRule)
                nodes.append("<path d=\"\(ds[idx])\" fill=\"\(fillColor)\"\(ruleAttr)/>")
            } else {
                if nodes.isEmpty { continue }
                let maskId = "\(idBase)_\(idx)"
                let cutD = ds[idx]
                defs +=
                    "<mask id=\"\(maskId)\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"\(formatNumber(vbW))\" height=\"\(formatNumber(vbH))\" mask-type=\"luminance\" style=\"mask-type:luminance\">"
                    + "<rect x=\"0\" y=\"0\" width=\"\(formatNumber(vbW))\" height=\"\(formatNumber(vbH))\" fill=\"#fff\"/>"
                    + "<path d=\"\(cutD)\" fill=\"#000\"\(fillRuleAttr(fill.fillRule))/>"
                    + "</mask>"
                nodes = ["<g mask=\"url(#\(maskId))\">\(nodes.joined())</g>"]
            }
        }
        let body = nodes.joined()
        let bgRect: String
        if let background = options.background {
            bgRect =
                "<rect x=\"0\" y=\"0\" width=\"\(formatNumber(vbW))\" height=\"\(formatNumber(vbH))\" fill=\"\(escapeXml(background))\"/>"
        } else {
            bgRect = ""
        }
        let defsBlock = defs.isEmpty ? "" : "<defs>\(defs)</defs>"
        let viewBox = "0 0 \(formatNumber(vbW)) \(formatNumber(vbH))"
        return
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(options.pointSize)\" height=\"\(options.pointSize)\" viewBox=\"\(viewBox)\" role=\"img\" aria-label=\"\(escapedName)\">\(defsBlock)\(bgRect)\(body)</svg>"
    }

    private static func subpathsToD(_ subpaths: [Subpath], _ flipX: (Double) -> Double, _ flipY: (Double) -> Double)
        -> String
    {
        var parts: [String] = []
        for sub in subpaths {
            for cmd in sub.commands {
                if cmd.op == "Z" {
                    parts.append("Z")
                    continue
                }
                var args = cmd.args
                var i = 0
                while i < args.count {
                    args[i] = flipX(args[i])
                    if i + 1 < args.count { args[i + 1] = flipY(args[i + 1]) }
                    i += 2
                }
                parts.append(cmd.op + args.map(formatNumber).joined(separator: " "))
            }
        }
        return parts.joined(separator: " ")
    }

    private static func fnv1a(_ str: String) -> String {
        var h: UInt32 = 0x811c_9dc5
        for scalar in str.unicodeScalars {
            h ^= UInt32(scalar.value & 0xFFFF)  // JS charCodeAt = UTF-16 code unit (BMP here)
            h = h &* 0x0100_0193
        }
        return String(h, radix: 36)
    }

    /// JS `n.toFixed(3)` then `replace(/\.?0+$/, '') || '0'`. The geometry is
    /// normalised to non-negative coords, so sign handling is unneeded.
    static func formatNumber(_ n: Double) -> String {
        if !n.isFinite { return "0" }
        var s = String(format: "%.3f", n)
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s.isEmpty ? "0" : s
    }

    /// JS default `Number → String` for vbW/vbH inside the fnv1a hash input. Only
    /// affects cut-out symbols' mask ids (not the gated square.grid.2x2 path).
    private static func jsNumberString(_ n: Double) -> String {
        if n == n.rounded(), abs(n) < 1e21 { return String(Int64(n)) }
        var s = String(n)
        if s.hasSuffix(".0") { s.removeLast(2) }
        return s
    }

    private static func fillRuleAttr(_ rule: String) -> String { rule == "evenodd" ? " fill-rule=\"evenodd\"" : "" }

    /// XML/SVG escape — the five XML 1.0 predefined entities — via the shared `ADFCore.XMLEscape`
    /// (byte-identical to the prior per-character switch).
    static func escapeXml(_ value: String) -> String { XMLEscape.escaped(value) }
}
