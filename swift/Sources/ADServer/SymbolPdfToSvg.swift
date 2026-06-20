// Byte-exact Swift port of the JS SF-Symbol PDF→SVG converter
// (src/resources/symbol-pdf-to-svg.js + its three submodules). The JS oracle is
// authoritative: `render_sf_symbol`'s gated parity test compares this output,
// byte-for-byte, against `symbolPdfToSvg(nativeSymbolPdf(...))`. Because the
// native `ADRender.SymbolPdf.render` already emits PDF bytes identical to the JS
// `nativeSymbolPdf` (proven by render-parity.test.js), the only thing that must
// match here is the conversion.
//
// Structure mirrors the JS file-for-file, split across siblings so each stays
// inside the size/complexity gate:
//   - SymbolPdfToSvg+PdfObjects.swift    ← symbol-pdf-to-svg/pdf-objects.js (object graph, FlateDecode)
//   - SymbolPdfToSvg+ContentStream.swift ← symbol-pdf-to-svg/content-stream.js (operator interpreter)
//   - SymbolPdfToSvg+SvgEmit.swift       ← symbol-pdf-to-svg/svg-emit.js (luminance-mask compositor)
//   - SymbolPdfToSvg+PdfScan.swift       ← the shared byte-scan helpers (`enum PdfScan`)
//   - this file: `SymbolPdfToSvg.convert(_:options:)` ← symbol-pdf-to-svg.js facade, plus the
//     `PdfValue` / `PdfObject` model the facade threads between the stages.
//
// Everything operates on raw bytes (the JS `bytesToLatin1` round-trip maps every
// byte 1:1 to a char in U+0000…U+00FF, so a `[UInt8]` view is equivalent and
// avoids any encoding ambiguity). Number/coordinate formatting and the FNV-1a
// mask-id hashing reproduce the JS string production exactly.

import Foundation

// MARK: - Errors

/// Mirrors the JS `ParseError` thrown by the converter — the caller maps any
/// throw to the same "this symbol can't be converted" outcome the JS path has
/// (the spawn/fallback in JS; a tool failure → self-skip here).
struct SymbolPdfParseError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

// MARK: - Public facade (symbol-pdf-to-svg.js)

enum SymbolPdfToSvg {
    /// Options for the converter, matching the JS `opts` bag
    /// (`{ name, pointSize, color, background }`) with the JS defaults applied at
    /// the `assembleSvg` boundary (name "", pointSize 128, color "currentColor",
    /// background nil).
    struct Options {
        var name: String
        var pointSize: Int
        var color: String
        var background: String?

        init(name: String = "", pointSize: Int = 128, color: String = "currentColor", background: String? = nil) {
            self.name = name
            self.pointSize = pointSize
            self.color = color
            self.background = background
        }
    }

    /// `symbolPdfToSvg(pdfBytes, opts)` — parse the single-page symbol PDF and
    /// emit a luminance-mask SVG. Throws `SymbolPdfParseError` on the same
    /// conditions the JS facade throws `ParseError`.
    static func convert(_ pdfBytes: [UInt8], options: Options) throws -> String {
        let objects = PdfObjects.collectObjects(pdfBytes)
        guard let page = PdfObjects.findPage(objects) else {
            throw SymbolPdfParseError("symbol PDF: no /Type /Page object found")
        }
        let resources = PdfObjects.resolveDict(page.dict["Resources"], objects)
        let extGState = PdfObjects.resolveDict(resources?["ExtGState"], objects) ?? [:]
        // alphaByName: ExtGState name → ca (parsed as a JS Number.parseFloat).
        var alphaByName: [String: Double] = [:]
        for (name, ref) in extGState {
            guard let dict = PdfObjects.resolveDict(ref, objects) else { continue }
            if let ca = dict["ca"], let value = ca.asParsedFloat { alphaByName[name] = value }
        }
        let contentRef = page.dict["Contents"]
        guard let contentObj = PdfObjects.resolveStreamObject(contentRef, objects) else {
            throw SymbolPdfParseError("symbol PDF: no content stream")
        }
        let stream = try PdfObjects.decodeStream(contentObj)
        let fills = ContentStream.parse(stream, alphaByName: alphaByName)
        if fills.isEmpty { throw SymbolPdfParseError("symbol PDF: no fill operations") }
        return try SvgEmit.assemble(fills, options: options)
    }
}

// MARK: - PDF values

/// A parsed PDF dictionary value, covering exactly the shapes the JS
/// `parseDictionary` produces for CGContext-emitted symbol PDFs: a number, a
/// "string" (a `/Name`, a bare token, or the trimmed contents of a `[...]`
/// array), an indirect reference (`{ ref: "n g" }`), or a nested dictionary.
enum PdfValue {
    case number(Double)
    case string(String)
    case ref(String)
    case dict([String: PdfValue])

    /// JS `value === '/Page'`-style equality: true only for a `.string` whose
    /// text matches exactly.
    func equals(_ other: String) -> Bool {
        if case .string(let s) = self { return s == other }
        return false
    }

    /// `Number.parseFloat(value)` — a `.number` passes through (when finite);
    /// a `.string` parses its leading numeric run (JS lenient parse). Anything
    /// else, or a non-numeric string, is nil (the JS `undefined`/`NaN` path).
    var asParsedFloat: Double? {
        switch self {
            case .number(let n): return n.isFinite ? n : nil
            case .string(let s): return PdfScan.jsParseFloat(s)
            default: return nil
        }
    }
}

/// One indexed `n g obj … endobj` block: its parsed dictionary and (for a
/// stream object) the raw, still-compressed payload bytes.
struct PdfObject {
    let id: String
    var dict: [String: PdfValue]
    var stream: [UInt8]?
}
