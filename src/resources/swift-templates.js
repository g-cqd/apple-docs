/**
 * Inline Swift programs spawned by src/resources/apple-assets.js. Each
 * is written to a temp .swift file (with mkdtemp-style path randomness)
 * and invoked via 'swift <path> <args>'.
 *
 * SYMBOL_WORKER_SCRIPT — long-running per-scope worker that reads
 *   symbol names on stdin and writes the resulting PDF bytes back on
 *   stdout. One worker per scope, pooled by spawnSymbolWorker.
 *
 * SYMBOL_PDF_SCRIPT — one-shot Swift renderer used as the fallback
 *   path when the snapshot SVG cache is missing.
 *
 * Extracted from apple-assets.js as part of P3.7. The bodies are kept
 * verbatim — Stryker disables the file via // Stryker disable all in
 * the original location. The constants stay tagged-template literals
 * so the existing await Bun.write(scriptPath, SYMBOL_*_SCRIPT) call
 * sites are unchanged.
 */

export const SYMBOL_WORKER_SCRIPT = `
import AppKit
import Foundation
import ObjectiveC
import CoreGraphics

// Long-lived SF Symbol → vector PDF worker. Reads "<name>\\n" lines on
// stdin, emits "<status:u32 BE><length:u32 BE><pdfBytes>" frames on stdout.
// status 0 = PDF bytes follow; non-zero = UTF-8 error message.
//
// Bun runs each frame through pdftocairo + cleanSymbolSvg() to produce the
// final SVG on disk. Keeping this worker single-purpose (PDF only) means we
// never have to round-trip vector geometry through Swift string formatting.

let scope = CommandLine.arguments[1]

func parseWeight(_ s: String) -> NSFont.Weight {
  switch s.lowercased() {
  case "ultralight": return .ultraLight
  case "thin": return .thin
  case "light": return .light
  case "medium": return .medium
  case "semibold": return .semibold
  case "bold": return .bold
  case "heavy": return .heavy
  case "black": return .black
  default: return .regular
  }
}
func parseScale(_ s: String) -> NSImage.SymbolScale {
  switch s.lowercased() {
  case "small": return .small
  case "large": return .large
  default: return .medium
  }
}

let publicProvider: (String, String, String) -> NSImage? = { name, weight, scale in
  let cfg = NSImage.SymbolConfiguration(pointSize: 256, weight: parseWeight(weight), scale: parseScale(scale))
  return NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
}
let privateBundles = [
  "/System/Library/CoreServices/CoreGlyphsPrivate.bundle",
  "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphsPrivate.bundle",
].compactMap { Bundle(path: $0) }
let privateProvider: (String) -> NSImage? = { name in
  privateBundles.lazy.compactMap { $0.image(forResource: name) }.first
}

func resolveImage(_ name: String, weight: String, scale: String) -> NSImage? {
  if scope == "private" { return privateProvider(name) }
  return publicProvider(name, weight, scale)
}

func renderPdf(_ name: String, weight: String, scale: String) throws -> Data {
  guard let image = resolveImage(name, weight: weight, scale: scale), let rep = image.representations.first else {
    throw NSError(domain: "apple-docs", code: 1, userInfo: [NSLocalizedDescriptionKey: "symbol not found"])
  }
  let vgSel = NSSelectorFromString("vectorGlyph")
  guard let vgImp = class_getMethodImplementation(object_getClass(rep)!, vgSel) else {
    throw NSError(domain: "apple-docs", code: 2, userInfo: [NSLocalizedDescriptionKey: "no vectorGlyph"])
  }
  typealias VG = @convention(c) (AnyObject, Selector) -> AnyObject?
  guard let vg = unsafeBitCast(vgImp, to: VG.self)(rep, vgSel) else {
    throw NSError(domain: "apple-docs", code: 3, userInfo: [NSLocalizedDescriptionKey: "vectorGlyph nil"])
  }
  let pdfData = NSMutableData()
  guard let consumer = CGDataConsumer(data: pdfData) else {
    throw NSError(domain: "apple-docs", code: 4, userInfo: [NSLocalizedDescriptionKey: "consumer nil"])
  }
  var box = CGRect(x: 0, y: 0, width: 2048, height: 2048)
  guard let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else {
    throw NSError(domain: "apple-docs", code: 5, userInfo: [NSLocalizedDescriptionKey: "ctx nil"])
  }
  ctx.beginPDFPage(nil)
  ctx.setFillColor(NSColor.black.cgColor)
  let drawSel = NSSelectorFromString("drawInContext:")
  guard let drawImp = class_getMethodImplementation(object_getClass(vg)!, drawSel) else {
    throw NSError(domain: "apple-docs", code: 6, userInfo: [NSLocalizedDescriptionKey: "no drawInContext:"])
  }
  typealias DrawFn = @convention(c) (AnyObject, Selector, CGContext) -> Void
  unsafeBitCast(drawImp, to: DrawFn.self)(vg, drawSel, ctx)
  ctx.endPDFPage()
  ctx.closePDF()
  return pdfData as Data
}

func writeFrame(status: UInt32, payload: Data) {
  var s = status.bigEndian
  var l = UInt32(payload.count).bigEndian
  let header = Data(bytes: &s, count: 4) + Data(bytes: &l, count: 4)
  FileHandle.standardOutput.write(header)
  FileHandle.standardOutput.write(payload)
}

while let line = readLine(strippingNewline: true) {
  if line.isEmpty { continue }
  let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
  let name = parts.count > 0 ? parts[0] : ""
  let weight = parts.count > 1 ? parts[1] : "regular"
  let scale = parts.count > 2 ? parts[2] : "medium"
  do {
    let pdf = try renderPdf(name, weight: weight, scale: scale)
    writeFrame(status: 0, payload: pdf)
  } catch {
    let message = (error as NSError).localizedDescription
    writeFrame(status: 1, payload: Data(message.utf8))
  }
}
`

export const SYMBOL_PDF_SCRIPT = `
import AppKit
import Foundation
import ObjectiveC
import CoreGraphics

// Single-shot SF Symbol → vector PDF renderer. Used by both the runtime
// /api/symbols/... handler (one symbol per spawn) and the worker pool
// invoked by prerenderSfSymbols (one process, many symbols).
//
// We deliberately apply NO transform to the CGContext: the canonical
// drawInContext: places the glyph at its natural orientation/scale within
// the page. Other transforms (Y-flip, scale, contentBounds-based offsets)
// produce wrong orientations for some symbols (house.fill, pencil) while
// keeping others correct — Apple's rendering already has per-symbol logic.

let name = CommandLine.arguments[1]
let scope = CommandLine.arguments[2]
let weightArg = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "regular"
let scaleArg = CommandLine.arguments.count > 4 ? CommandLine.arguments[4] : "medium"

func parseWeight(_ s: String) -> NSFont.Weight {
  switch s.lowercased() {
  case "ultralight": return .ultraLight
  case "thin": return .thin
  case "light": return .light
  case "medium": return .medium
  case "semibold": return .semibold
  case "bold": return .bold
  case "heavy": return .heavy
  case "black": return .black
  default: return .regular
  }
}
func parseScale(_ s: String) -> NSImage.SymbolScale {
  switch s.lowercased() {
  case "small": return .small
  case "large": return .large
  default: return .medium
  }
}

let publicProvider: (String) -> NSImage? = { name in
  let cfg = NSImage.SymbolConfiguration(pointSize: 256, weight: parseWeight(weightArg), scale: parseScale(scaleArg))
  return NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
}
let privateBundles = [
  "/System/Library/CoreServices/CoreGlyphsPrivate.bundle",
  "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphsPrivate.bundle",
].compactMap { Bundle(path: $0) }
let privateProvider: (String) -> NSImage? = { name in
  privateBundles.lazy.compactMap { $0.image(forResource: name) }.first
}
let provider = scope == "private" ? privateProvider : publicProvider

guard let image = provider(name), let rep = image.representations.first else {
  FileHandle.standardError.write(Data("symbol not found".utf8))
  exit(2)
}
let vgSel = NSSelectorFromString("vectorGlyph")
guard let vgImp = class_getMethodImplementation(object_getClass(rep)!, vgSel) else {
  FileHandle.standardError.write(Data("no vectorGlyph selector".utf8))
  exit(3)
}
typealias VGGetter = @convention(c) (AnyObject, Selector) -> AnyObject?
guard let vg = unsafeBitCast(vgImp, to: VGGetter.self)(rep, vgSel) else {
  FileHandle.standardError.write(Data("vectorGlyph returned nil".utf8))
  exit(4)
}

let pdfData = NSMutableData()
guard let consumer = CGDataConsumer(data: pdfData) else { exit(5) }
var box = CGRect(x: 0, y: 0, width: 2048, height: 2048)
guard let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { exit(6) }
ctx.beginPDFPage(nil)
ctx.setFillColor(NSColor.black.cgColor)
let drawSel = NSSelectorFromString("drawInContext:")
guard let drawImp = class_getMethodImplementation(object_getClass(vg)!, drawSel) else {
  FileHandle.standardError.write(Data("no drawInContext: selector".utf8))
  exit(7)
}
typealias DrawFn = @convention(c) (AnyObject, Selector, CGContext) -> Void
unsafeBitCast(drawImp, to: DrawFn.self)(vg, drawSel, ctx)
ctx.endPDFPage()
ctx.closePDF()
FileHandle.standardOutput.write(pdfData as Data)
`

/**
 * FONT_TEXT_SCRIPT — one-shot Swift renderer that loads a font file via
 * CTFontManager, lays out a string, walks each glyph's path, and emits an
 * SVG with absolute coordinates. Used by apple-fonts/render.js to produce
 * theme-neutral previews of the user's selected font + sample text.
 */
export const FONT_TEXT_SCRIPT = `
import CoreText
import Foundation
import CoreGraphics

let fontPath = CommandLine.arguments[1]
let text = CommandLine.arguments[2]
let pointSize = CGFloat(Double(CommandLine.arguments[3]) ?? 96)
let url = URL(fileURLWithPath: fontPath)
var error: Unmanaged<CFError>?
CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
      let descriptor = descriptors.first,
      let fontName = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) as? String
else {
  FileHandle.standardError.write(Data("unable to load font descriptors".utf8))
  exit(2)
}
let font = CTFontCreateWithName(fontName as CFString, pointSize, nil)
let attr = NSAttributedString(string: text, attributes: [kCTFontAttributeName as NSAttributedString.Key: font])
let line = CTLineCreateWithAttributedString(attr)
let runs = CTLineGetGlyphRuns(line) as! [CTRun]

struct Shape {
  let d: String
  let bounds: CGRect
}

var shapes: [Shape] = []
var overall = CGRect.null

func fmt(_ value: CGFloat) -> String {
  let raw = String(format: "%.3f", Double(value))
  var out = raw
  while out.contains(".") && out.hasSuffix("0") { out.removeLast() }
  if out.hasSuffix(".") { out.removeLast() }
  return out
}

func convert(_ p: CGPoint, bounds: CGRect) -> CGPoint {
  CGPoint(x: p.x - bounds.minX, y: bounds.maxY - p.y)
}

for run in runs {
  let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
  let count = CTRunGetGlyphCount(run)
  var glyphs = Array(repeating: CGGlyph(), count: count)
  var positions = Array(repeating: CGPoint.zero, count: count)
  CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
  CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
  for index in 0..<count {
    guard let path = CTFontCreatePathForGlyph(runFont, glyphs[index], nil) else { continue }
    let offset = positions[index]
    var transform = CGAffineTransform(translationX: offset.x, y: offset.y)
    let translated = path.copy(using: &transform) ?? path
    let bounds = translated.boundingBoxOfPath
    if bounds.isNull || bounds.isEmpty { continue }
    overall = overall.union(bounds)
    var d = ""
    translated.applyWithBlock { elementPointer in
      let element = elementPointer.pointee
      switch element.type {
      case .moveToPoint:
        let p = element.points[0]
        d += "M\\(fmt(p.x)) \\(fmt(p.y)) "
      case .addLineToPoint:
        let p = element.points[0]
        d += "L\\(fmt(p.x)) \\(fmt(p.y)) "
      case .addQuadCurveToPoint:
        let c = element.points[0]
        let p = element.points[1]
        d += "Q\\(fmt(c.x)) \\(fmt(c.y)) \\(fmt(p.x)) \\(fmt(p.y)) "
      case .addCurveToPoint:
        let c1 = element.points[0]
        let c2 = element.points[1]
        let p = element.points[2]
        d += "C\\(fmt(c1.x)) \\(fmt(c1.y)) \\(fmt(c2.x)) \\(fmt(c2.y)) \\(fmt(p.x)) \\(fmt(p.y)) "
      case .closeSubpath:
        d += "Z "
      @unknown default:
        break
      }
    }
    shapes.append(Shape(d: d, bounds: bounds))
  }
}

guard !overall.isNull, !shapes.isEmpty else {
  FileHandle.standardError.write(Data("no glyph outlines".utf8))
  exit(3)
}

let padding = max(4, pointSize * 0.08)
let width = ceil(overall.width + padding * 2)
let height = ceil(overall.height + padding * 2)
var output = "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>\\n"
output += "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"\\(fmt(width))\\" height=\\"\\(fmt(height))\\" viewBox=\\"0 0 \\(fmt(width)) \\(fmt(height))\\">\\n"
output += "  <title>\\(text.xmlEscaped)</title>\\n"
output += "  <g fill=\\"black\\">\\n"
for shape in shapes {
  var normalized = ""
  let scanner = PathNormalizer(d: shape.d, bounds: overall, padding: padding, height: height)
  normalized = scanner.normalized()
  output += "    <path d=\\"\\(normalized)\\"/>\\n"
}
output += "  </g>\\n</svg>\\n"
FileHandle.standardOutput.write(Data(output.utf8))

final class PathNormalizer {
  let tokens: [String]
  let bounds: CGRect
  let padding: CGFloat
  let height: CGFloat
  init(d: String, bounds: CGRect, padding: CGFloat, height: CGFloat) {
    self.tokens = d.split(separator: " ").map(String.init)
    self.bounds = bounds
    self.padding = padding
    self.height = height
  }
  func normalized() -> String {
    var out: [String] = []
    var index = 0
    while index < tokens.count {
      let op = tokens[index]
      index += 1
      if op == "Z" {
        out.append("Z")
        continue
      }
      let command = String(op.prefix(1))
      let firstNumber = String(op.dropFirst())
      var nums: [CGFloat] = []
      if let n = Double(firstNumber) { nums.append(CGFloat(n)) }
      let needed: Int
      switch command {
      case "M", "L": needed = 2
      case "Q": needed = 4
      case "C": needed = 6
      default: needed = 0
      }
      while nums.count < needed && index < tokens.count {
        if let n = Double(tokens[index]) { nums.append(CGFloat(n)) }
        index += 1
      }
      var converted: [String] = []
      for i in stride(from: 0, to: nums.count, by: 2) {
        let x = nums[i] - bounds.minX + padding
        let y = height - (nums[i + 1] - bounds.minY + padding)
        converted.append(fmt(x))
        converted.append(fmt(y))
      }
      out.append("\\(command)\\(converted.joined(separator: " "))")
    }
    return out.joined(separator: " ")
  }
}

extension String {
  var xmlEscaped: String {
    self
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&apos;")
  }
}
`
