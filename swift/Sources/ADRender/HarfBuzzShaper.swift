// Runtime dlopen binding to system HarfBuzz: shape text + walk glyph
// outlines into an SVG. Zero-build-dep dlopen contract — library absent →
// nil → the JS side falls back to the hb-view spawn / placeholder.
// Cross-platform (dlopen works on Linux + darwin); darwin keeps CoreText,
// this serves Linux.
//
// HarfBuzz-only: hb_font_draw_glyph (HB 7+) yields glyph outlines via draw
// callbacks, so no FreeType struct-mirroring is needed. The shaping is the
// same code hb-view runs, so glyph selection/advances match exactly; only
// the SVG serialisation differs (tolerance-gated, not byte-identical).

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

// Stable HarfBuzz ABI structs (hb-buffer.h). Both are 20 bytes; the
// trailing private vars never move.
struct HBGlyphInfo {
    var codepoint: UInt32
    var mask: UInt32
    var cluster: UInt32
    var var1: UInt32
    var var2: UInt32
}

struct HBGlyphPosition {
    var xAdvance: Int32
    var yAdvance: Int32
    var xOffset: Int32
    var yOffset: Int32
    var v: UInt32
}

typealias HBMoveTo =
    @convention(c) (OpaquePointer?, UnsafeMutableRawPointer?, OpaquePointer?, Float, Float, UnsafeMutableRawPointer?) ->
    Void
typealias HBLineTo = HBMoveTo
typealias HBQuadTo =
    @convention(c) (
        OpaquePointer?, UnsafeMutableRawPointer?, OpaquePointer?, Float, Float, Float, Float, UnsafeMutableRawPointer?
    ) -> Void
typealias HBCubicTo =
    @convention(c) (
        OpaquePointer?, UnsafeMutableRawPointer?, OpaquePointer?, Float, Float, Float, Float, Float, Float,
        UnsafeMutableRawPointer?
    ) -> Void
typealias HBClose =
    @convention(c) (OpaquePointer?, UnsafeMutableRawPointer?, OpaquePointer?, UnsafeMutableRawPointer?) -> Void

struct HarfBuzzLib: @unchecked Sendable {
    let version:
        @convention(c) (UnsafeMutablePointer<UInt32>?, UnsafeMutablePointer<UInt32>?, UnsafeMutablePointer<UInt32>?) ->
            Void
    let blobCreateFromFile: @convention(c) (UnsafePointer<CChar>?) -> OpaquePointer?
    let blobDestroy: @convention(c) (OpaquePointer?) -> Void
    let faceCreate: @convention(c) (OpaquePointer?, UInt32) -> OpaquePointer?
    let faceGetUpem: @convention(c) (OpaquePointer?) -> UInt32
    let faceDestroy: @convention(c) (OpaquePointer?) -> Void
    let fontCreate: @convention(c) (OpaquePointer?) -> OpaquePointer?
    let fontSetScale: @convention(c) (OpaquePointer?, Int32, Int32) -> Void
    let fontDestroy: @convention(c) (OpaquePointer?) -> Void
    let bufferCreate: @convention(c) () -> OpaquePointer?
    let bufferAddUtf8: @convention(c) (OpaquePointer?, UnsafePointer<CChar>?, Int32, UInt32, Int32) -> Void
    let bufferGuessSegmentProperties: @convention(c) (OpaquePointer?) -> Void
    let bufferDestroy: @convention(c) (OpaquePointer?) -> Void
    let shape: @convention(c) (OpaquePointer?, OpaquePointer?, UnsafeRawPointer?, UInt32) -> Void
    let bufferGetLength: @convention(c) (OpaquePointer?) -> UInt32
    let bufferGetGlyphInfos: @convention(c) (OpaquePointer?, UnsafeMutablePointer<UInt32>?) -> UnsafeMutableRawPointer?
    let bufferGetGlyphPositions:
        @convention(c) (OpaquePointer?, UnsafeMutablePointer<UInt32>?) -> UnsafeMutableRawPointer?
    let drawFuncsCreate: @convention(c) () -> OpaquePointer?
    let drawFuncsSetMoveTo:
        @convention(c) (OpaquePointer?, HBMoveTo, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?) -> Void
    let drawFuncsSetLineTo:
        @convention(c) (OpaquePointer?, HBLineTo, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?) -> Void
    let drawFuncsSetQuadTo:
        @convention(c) (OpaquePointer?, HBQuadTo, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?) -> Void
    let drawFuncsSetCubicTo:
        @convention(c) (OpaquePointer?, HBCubicTo, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?) -> Void
    let drawFuncsSetClose:
        @convention(c) (OpaquePointer?, HBClose, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?) -> Void
    let fontDrawGlyph: @convention(c) (OpaquePointer?, UInt32, OpaquePointer?, UnsafeMutableRawPointer?) -> Void
}

// Accumulates one shaped run's glyph outlines as a single SVG path string.
// HarfBuzz draw coords are y-up in 26.6 px (we set scale = pointSize*64);
// SVG is y-down with the baseline at y=0, so we negate y. Per-glyph pen
// offset (advance + mark offset) is added before scaling.
private final class GlyphPen {
    var d = ""
    var ox = 0.0
    var oy = 0.0
    var minX = Double.infinity
    var minY = Double.infinity
    var maxX = -Double.infinity
    var maxY = -Double.infinity
    private let inv = 1.0 / 64.0

    private func track(_ x: Double, _ y: Double) {
        if x < minX { minX = x }
        if x > maxX { maxX = x }
        if y < minY { minY = y }
        if y > maxY { maxY = y }
    }
    private func sx(_ x: Float) -> Double { (ox + Double(x)) * inv }
    private func sy(_ y: Float) -> Double { -(oy + Double(y)) * inv }

    func move(_ x: Float, _ y: Float) {
        let px = sx(x)
        let py = sy(y)
        track(px, py)
        d += "M\(fmt(px)) \(fmt(py))"
    }
    func line(_ x: Float, _ y: Float) {
        let px = sx(x)
        let py = sy(y)
        track(px, py)
        d += "L\(fmt(px)) \(fmt(py))"
    }
    func quad(_ cx: Float, _ cy: Float, _ x: Float, _ y: Float) {
        let pcx = sx(cx)
        let pcy = sy(cy)
        let px = sx(x)
        let py = sy(y)
        track(px, py)
        d += "Q\(fmt(pcx)) \(fmt(pcy)) \(fmt(px)) \(fmt(py))"
    }
    func cubic(_ c1x: Float, _ c1y: Float, _ c2x: Float, _ c2y: Float, _ x: Float, _ y: Float) {
        let p1x = sx(c1x)
        let p1y = sy(c1y)
        let p2x = sx(c2x)
        let p2y = sy(c2y)
        let px = sx(x)
        let py = sy(y)
        track(px, py)
        d += "C\(fmt(p1x)) \(fmt(p1y)) \(fmt(p2x)) \(fmt(p2y)) \(fmt(px)) \(fmt(py))"
    }
    func close() { d += "Z" }
}

// Locale-free fixed-point formatter, 6 decimals with trailing zeros
// stripped. 6 decimals exactly represents the font's 26.6 fixed-point grid
// (1/64 = 0.015625), so the emitted path keeps every bit of the outline
// precision HarfBuzz delivers — matching hb-view's own serialisation.
private let fmtScale = 1_000_000
private func fmt(_ value: Double) -> String {
    var n = Int64((value * Double(fmtScale)).rounded())
    if n == 0 { return "0" }
    let neg = n < 0
    if neg { n = -n }
    let ip = n / Int64(fmtScale)
    let fp = n % Int64(fmtScale)
    var frac = ""
    if fp != 0 {
        var digits = "\(fp)"
        while digits.count < 6 { digits = "0" + digits }  // zero-pad to 6 places
        while digits.hasSuffix("0") { digits.removeLast() }
        frac = "." + digits
    }
    return (neg ? "-" : "") + "\(ip)" + frac
}

public enum HarfBuzzShaper {
    private static let candidates: [String] = {
        #if canImport(Darwin)
            return [
                "/opt/homebrew/lib/libharfbuzz.0.dylib",
                "/usr/local/lib/libharfbuzz.0.dylib",
                "/opt/local/lib/libharfbuzz.0.dylib"
            ]
        #else
            return ["libharfbuzz.so.0"]
        #endif
    }()

    static let shared: HarfBuzzLib? = {
        for path in candidates {
            guard let h = dlopen(path, RTLD_NOW | RTLD_LOCAL) else { continue }
            func sym<T>(_ name: String, as type: T.Type) -> T? {
                guard let raw = dlsym(h, name) else { return nil }
                return unsafeBitCast(raw, to: T.self)
            }
            guard
                let version = sym(
                    "hb_version",
                    as: (@convention(c) (
                        UnsafeMutablePointer<UInt32>?, UnsafeMutablePointer<UInt32>?, UnsafeMutablePointer<UInt32>?
                    ) -> Void)
                    .self),
                let blobFile = sym(
                    "hb_blob_create_from_file_or_fail",
                    as: (@convention(c) (UnsafePointer<CChar>?) -> OpaquePointer?).self),
                let blobDestroy = sym("hb_blob_destroy", as: (@convention(c) (OpaquePointer?) -> Void).self),
                let faceCreate = sym(
                    "hb_face_create", as: (@convention(c) (OpaquePointer?, UInt32) -> OpaquePointer?).self),
                let faceUpem = sym("hb_face_get_upem", as: (@convention(c) (OpaquePointer?) -> UInt32).self),
                let faceDestroy = sym("hb_face_destroy", as: (@convention(c) (OpaquePointer?) -> Void).self),
                let fontCreate = sym("hb_font_create", as: (@convention(c) (OpaquePointer?) -> OpaquePointer?).self),
                let fontSetScale = sym(
                    "hb_font_set_scale", as: (@convention(c) (OpaquePointer?, Int32, Int32) -> Void).self),
                let fontDestroy = sym("hb_font_destroy", as: (@convention(c) (OpaquePointer?) -> Void).self),
                let bufCreate = sym("hb_buffer_create", as: (@convention(c) () -> OpaquePointer?).self),
                let bufAddUtf8 = sym(
                    "hb_buffer_add_utf8",
                    as: (@convention(c) (OpaquePointer?, UnsafePointer<CChar>?, Int32, UInt32, Int32) -> Void).self),
                let bufGuess = sym(
                    "hb_buffer_guess_segment_properties", as: (@convention(c) (OpaquePointer?) -> Void).self),
                let bufDestroy = sym("hb_buffer_destroy", as: (@convention(c) (OpaquePointer?) -> Void).self),
                let shape = sym(
                    "hb_shape",
                    as: (@convention(c) (OpaquePointer?, OpaquePointer?, UnsafeRawPointer?, UInt32) -> Void).self),
                let bufLen = sym("hb_buffer_get_length", as: (@convention(c) (OpaquePointer?) -> UInt32).self),
                let bufInfos = sym(
                    "hb_buffer_get_glyph_infos",
                    as: (@convention(c) (OpaquePointer?, UnsafeMutablePointer<UInt32>?) -> UnsafeMutableRawPointer?)
                        .self),
                let bufPos = sym(
                    "hb_buffer_get_glyph_positions",
                    as: (@convention(c) (OpaquePointer?, UnsafeMutablePointer<UInt32>?) -> UnsafeMutableRawPointer?)
                        .self),
                let dfCreate = sym("hb_draw_funcs_create", as: (@convention(c) () -> OpaquePointer?).self),
                let dfMove = sym(
                    "hb_draw_funcs_set_move_to_func",
                    as: (@convention(c) (OpaquePointer?, HBMoveTo, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?)
                        -> Void)
                        .self),
                let dfLine = sym(
                    "hb_draw_funcs_set_line_to_func",
                    as: (@convention(c) (OpaquePointer?, HBLineTo, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?)
                        -> Void)
                        .self),
                let dfQuad = sym(
                    "hb_draw_funcs_set_quadratic_to_func",
                    as: (@convention(c) (OpaquePointer?, HBQuadTo, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?)
                        -> Void)
                        .self),
                let dfCubic = sym(
                    "hb_draw_funcs_set_cubic_to_func",
                    as: (@convention(c) (OpaquePointer?, HBCubicTo, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?)
                        -> Void)
                        .self),
                let dfClose = sym(
                    "hb_draw_funcs_set_close_path_func",
                    as: (@convention(c) (OpaquePointer?, HBClose, UnsafeMutableRawPointer?, UnsafeMutableRawPointer?) ->
                        Void)
                        .self),
                let drawGlyph = sym(
                    "hb_font_draw_glyph",
                    as: (@convention(c) (OpaquePointer?, UInt32, OpaquePointer?, UnsafeMutableRawPointer?) -> Void).self
                )
            else { continue }
            // hb_version writes all three out-params unconditionally (no null
            // guard), so pass real storage for each.
            var major: UInt32 = 0
            var minor: UInt32 = 0
            var micro: UInt32 = 0
            version(&major, &minor, &micro)
            guard major >= 7 else { continue }  // hb_font_draw_glyph landed in 7.0
            return HarfBuzzLib(
                version: version, blobCreateFromFile: blobFile, blobDestroy: blobDestroy,
                faceCreate: faceCreate, faceGetUpem: faceUpem, faceDestroy: faceDestroy,
                fontCreate: fontCreate, fontSetScale: fontSetScale, fontDestroy: fontDestroy,
                bufferCreate: bufCreate, bufferAddUtf8: bufAddUtf8,
                bufferGuessSegmentProperties: bufGuess, bufferDestroy: bufDestroy, shape: shape,
                bufferGetLength: bufLen, bufferGetGlyphInfos: bufInfos, bufferGetGlyphPositions: bufPos,
                drawFuncsCreate: dfCreate, drawFuncsSetMoveTo: dfMove, drawFuncsSetLineTo: dfLine,
                drawFuncsSetQuadTo: dfQuad, drawFuncsSetCubicTo: dfCubic, drawFuncsSetClose: dfClose,
                fontDrawGlyph: drawGlyph)
        }
        return nil
    }()

    // One shared draw-funcs object; the callbacks reach the per-glyph
    // GlyphPen through draw_data (passed unretained to hb_font_draw_glyph).
    // Immutable after construction (built once, used read-only).
    private nonisolated(unsafe) static let drawFuncs: OpaquePointer? = {
        guard let hb = shared, let df = hb.drawFuncsCreate() else { return nil }
        let move: HBMoveTo = { _, dd, _, x, y, _ in Unmanaged<GlyphPen>.fromOpaque(dd!).takeUnretainedValue().move(x, y)
        }
        let line: HBLineTo = { _, dd, _, x, y, _ in Unmanaged<GlyphPen>.fromOpaque(dd!).takeUnretainedValue().line(x, y)
        }
        let quad: HBQuadTo = { _, dd, _, cx, cy, x, y, _ in
            Unmanaged<GlyphPen>.fromOpaque(dd!).takeUnretainedValue().quad(cx, cy, x, y)
        }
        let cubic: HBCubicTo = { _, dd, _, c1x, c1y, c2x, c2y, x, y, _ in
            Unmanaged<GlyphPen>.fromOpaque(dd!).takeUnretainedValue().cubic(c1x, c1y, c2x, c2y, x, y)
        }
        let close: HBClose = { _, dd, _, _ in Unmanaged<GlyphPen>.fromOpaque(dd!).takeUnretainedValue().close() }
        hb.drawFuncsSetMoveTo(df, move, nil, nil)
        hb.drawFuncsSetLineTo(df, line, nil, nil)
        hb.drawFuncsSetQuadTo(df, quad, nil, nil)
        hb.drawFuncsSetCubicTo(df, cubic, nil, nil)
        hb.drawFuncsSetClose(df, close, nil, nil)
        return df
    }()

    /// Shape `text` in the font at `fontPath` and emit an SVG of the glyph
    /// outlines (black fills, transparent background), or nil if HarfBuzz is
    /// absent / the font won't load / nothing shaped.
    public static func renderSVG(fontPath: String, text: String, pointSize: Double) -> [UInt8]? {
        guard let hb = shared, let df = drawFuncs else { return nil }
        guard let blob = fontPath.withCString({ hb.blobCreateFromFile($0) }) else { return nil }
        defer { hb.blobDestroy(blob) }
        guard let face = hb.faceCreate(blob, 0) else { return nil }
        defer { hb.faceDestroy(face) }
        guard hb.faceGetUpem(face) > 0, let font = hb.fontCreate(face) else { return nil }
        defer { hb.fontDestroy(font) }
        let scale = Int32((pointSize * 64).rounded())
        hb.fontSetScale(font, scale, scale)

        guard let buf = hb.bufferCreate() else { return nil }
        defer { hb.bufferDestroy(buf) }
        let utf8 = Array(text.utf8)
        utf8.withUnsafeBufferPointer { p in
            p.baseAddress?
                .withMemoryRebound(to: CChar.self, capacity: p.count) {
                    hb.bufferAddUtf8(buf, $0, Int32(p.count), 0, Int32(p.count))
                }
        }
        hb.bufferGuessSegmentProperties(buf)
        hb.shape(font, buf, nil, 0)
        let n = Int(hb.bufferGetLength(buf))
        guard n > 0, let infosRaw = hb.bufferGetGlyphInfos(buf, nil), let posRaw = hb.bufferGetGlyphPositions(buf, nil)
        else {
            return nil
        }
        let infos = infosRaw.assumingMemoryBound(to: HBGlyphInfo.self)
        let pos = posRaw.assumingMemoryBound(to: HBGlyphPosition.self)

        let pen = GlyphPen()
        let penRef = Unmanaged.passUnretained(pen).toOpaque()
        var penX = 0.0
        var penY = 0.0
        for i in 0 ..< n {
            pen.ox = penX + Double(pos[i].xOffset)
            pen.oy = penY + Double(pos[i].yOffset)
            hb.fontDrawGlyph(font, infos[i].codepoint, df, penRef)
            penX += Double(pos[i].xAdvance)
            penY += Double(pos[i].yAdvance)
        }
        guard pen.d.isEmpty == false, pen.minX.isFinite else { return nil }

        // Pad the content bbox a touch so anti-aliased edges aren't clipped.
        let pad = pointSize * 0.06
        let x = pen.minX - pad
        let y = pen.minY - pad
        let w = (pen.maxX - pen.minX) + pad * 2
        let h = (pen.maxY - pen.minY) + pad * 2
        let svg = """
            <?xml version="1.0" encoding="UTF-8"?>
            <svg xmlns="http://www.w3.org/2000/svg" width="\(fmt(w))" height="\(fmt(h))" viewBox="\(fmt(x)) \(fmt(y)) \(fmt(w)) \(fmt(h))" role="img"><path d="\(pen.d)" fill="#000"/></svg>
            """
        return Array(svg.utf8)
    }
}
