public import AppleDocsSetup
import Foundation

#if os(macOS)
    import CoreGraphics
    import CoreText
#endif

/// Renders glyph outlines for a local Apple font file into a self-contained SVG string using
/// CoreText on macOS, or throws ``SetupError/unsupportedOnPlatform(feature:)`` on Linux.
public enum DarwinFontRenderer: Sendable {
    /// Renders `text` at `pointSize` using the font file at `fontFilePath` into an SVG document.
    public static func renderSVG(
        fontFilePath: String,
        text: String,
        pointSize: Double = 48
    ) throws(SetupError) -> String {
        #if os(macOS)
            let clampedSize = max(8.0, min(pointSize, 512.0))
            let trimmed = String(text.prefix(256))
            guard !trimmed.isEmpty else {
                throw .ioFailure("Text to render must not be empty.")
            }
            let font = try loadCTFont(at: fontFilePath, size: CGFloat(clampedSize))
            let line = try makeCTLine(text: trimmed, font: font)
            let (paths, maxX) = collectGlyphPaths(line: line, font: font)
            let totalHeight = max(CGFloat(clampedSize), CTFontGetAscent(font) + CTFontGetDescent(font))
            let width = max(Int((maxX + CGFloat(clampedSize)).rounded(.up)) + 16, Int(clampedSize) + 16)
            let height = Int(totalHeight.rounded(.up)) + 16
            return """
                <?xml version="1.0" encoding="UTF-8"?>
                <svg xmlns="http://www.w3.org/2000/svg" width="\(width)" height="\(height)" viewBox="0 0 \(width) \(height)">\(paths.joined())</svg>
                """
        #else
            _ = (fontFilePath, text, pointSize)
            throw .unsupportedOnPlatform(feature: "CoreText font SVG rendering")
        #endif
    }

    #if os(macOS)
        private static func loadCTFont(at path: String, size: CGFloat) throws(SetupError) -> CTFont {
            let url = URL(fileURLWithPath: path) as CFURL
            guard
                let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url) as? [CTFontDescriptor],
                let descriptor = descriptors.first
            else {
                throw .ioFailure("Unable to load font descriptor from \(path).")
            }
            return CTFontCreateWithFontDescriptor(descriptor, size, nil)
        }

        private static func makeCTLine(text: String, font: CTFont) throws(SetupError) -> CTLine {
            guard
                let attr = CFAttributedStringCreate(
                    nil,
                    text as CFString,
                    [kCTFontAttributeName: font] as CFDictionary
                )
            else {
                throw .ioFailure("Unable to construct attributed string.")
            }
            return CTLineCreateWithAttributedString(attr)
        }

        private static func collectGlyphPaths(line: CTLine, font: CTFont) -> ([String], CGFloat) {
            let runs = CTLineGetGlyphRuns(line) as? [CTRun] ?? []
            let ascent = CTFontGetAscent(font)
            var paths: [String] = []
            var maxX: CGFloat = 0

            for run in runs {
                let count = CTRunGetGlyphCount(run)
                guard count > 0 else { continue }
                var glyphs = [CGGlyph](repeating: 0, count: count)
                var positions = [CGPoint](repeating: .zero, count: count)
                CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
                CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)

                for idx in 0 ..< count {
                    let origin = positions[idx]
                    if origin.x > maxX { maxX = origin.x }
                    var flip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: origin.x + 8, ty: ascent + 8)
                    if let cgPath = unsafe CTFontCreatePathForGlyph(font, glyphs[idx], &flip) {
                        let d = svgPathData(from: cgPath)
                        if !d.isEmpty { paths.append("<path d=\"\(d)\" fill=\"currentColor\"/>") }
                    }
                }
            }
            return (paths, maxX)
        }

        private static func svgPathData(from cgPath: CGPath) -> String {
            var commands: [String] = []
            cgPath.applyWithBlock { elementPointer in
                let element = unsafe elementPointer.pointee
                let pts = unsafe element.points
                switch element.type {
                    case .moveToPoint:
                        commands.append("M\(unsafe formatPoints(pts, count: 1))")
                    case .addLineToPoint:
                        commands.append("L\(unsafe formatPoints(pts, count: 1))")
                    case .addQuadCurveToPoint:
                        commands.append("Q\(unsafe formatPoints(pts, count: 2))")
                    case .addCurveToPoint:
                        commands.append("C\(unsafe formatPoints(pts, count: 3))")
                    case .closeSubpath:
                        commands.append("Z")
                    @unknown default:
                        break
                }
            }
            return commands.joined(separator: " ")
        }

        private static func formatPoints(_ pts: UnsafeMutablePointer<CGPoint>, count: Int) -> String {
            (0 ..< count)
                .map { idx in
                    let p = unsafe pts[idx]
                    return "\(fmt(p.x)) \(fmt(p.y))"
                }
                .joined(separator: " ")
        }

        private static func fmt(_ value: CGFloat) -> String {
            let rounded = (Double(value) * 100.0).rounded() / 100.0
            return rounded.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(rounded)) : String(rounded)
        }
    #endif
}
