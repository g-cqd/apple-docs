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
