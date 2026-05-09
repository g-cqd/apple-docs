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
