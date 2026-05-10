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
  // Symbols that aren't vector-backed (emoji.* and a handful of other
  // private bitmap reps) don't implement -vectorGlyph. Detect via
  // respondsToSelector — class_getMethodImplementation always returns
  // a non-nil forwarding stub for missing selectors, which crashes
  // the worker when invoked. The respondsToSelector check turns the
  // crash into a clean per-symbol error.
  let vgSel = NSSelectorFromString("vectorGlyph")
  guard let repClass = object_getClass(rep), class_respondsToSelector(repClass, vgSel) else {
    throw NSError(domain: "apple-docs", code: 2, userInfo: [NSLocalizedDescriptionKey: "symbol has no vectorGlyph (likely bitmap-backed)"])
  }
  let vgImp = class_getMethodImplementation(repClass, vgSel)!
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
  guard let vgClass = object_getClass(vg), class_respondsToSelector(vgClass, drawSel) else {
    throw NSError(domain: "apple-docs", code: 6, userInfo: [NSLocalizedDescriptionKey: "vectorGlyph has no drawInContext:"])
  }
  let drawImp = class_getMethodImplementation(vgClass, drawSel)!
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
