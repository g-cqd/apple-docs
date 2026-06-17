// SF Symbol → vector PDF. AppKit + private `vectorGlyph`/`drawInContext:`
// selectors — DARWIN-ONLY (#if canImport(AppKit)); the Linux slice has no
// symbol here.
//
// Unlike the spawn (isolated process), this runs in-process on the
// FFI-calling thread, which has no AppKit runloop — it must be
// crash/hang-free before any caller uses it.

#if canImport(AppKit)
import AppKit
import CoreGraphics
import Foundation
import ObjectiveC

public enum SymbolPdf {
  private static func parseWeight(_ s: String) -> NSFont.Weight {
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

  private static func parseScale(_ s: String) -> NSImage.SymbolScale {
    switch s.lowercased() {
    case "small": return .small
    case "large": return .large
    default: return .medium
    }
  }

  private static let privateBundles: [Bundle] = [
    "/System/Library/CoreServices/CoreGlyphsPrivate.bundle",
    "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphsPrivate.bundle",
  ].compactMap { Bundle(path: $0) }

  /// Render the named symbol to a vector PDF, or nil on any failure (symbol
  /// not found, missing private selector) — the JS dispatch then falls back
  /// to the spawn path exactly as a non-zero script exit would.
  ///
  /// The whole body runs in an `autoreleasepool`: the FFI-calling thread
  /// (and GCD worker threads under the batch export) has no runloop to drain
  /// AppKit temporaries, so without this a long prerender's RSS climbs
  /// unbounded.
  public static func render(name: String, scope: String, weight: String, scale: String) -> [UInt8]? {
    autoreleasepool {
      let image: NSImage?
      if scope == "private" {
        image = privateBundles.lazy.compactMap { $0.image(forResource: name) }.first
      } else {
        let cfg = NSImage.SymbolConfiguration(
          pointSize: 256, weight: parseWeight(weight), scale: parseScale(scale))
        image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
          .withSymbolConfiguration(cfg)
      }
      guard let image, let rep = image.representations.first else { return nil }

      let vgSel = NSSelectorFromString("vectorGlyph")
      guard let vgImp = class_getMethodImplementation(object_getClass(rep)!, vgSel) else { return nil }
      typealias VGGetter = @convention(c) (AnyObject, Selector) -> AnyObject?
      guard let vg = unsafeBitCast(vgImp, to: VGGetter.self)(rep, vgSel) else { return nil }

      let pdfData = NSMutableData()
      guard let consumer = CGDataConsumer(data: pdfData) else { return nil }
      var box = CGRect(x: 0, y: 0, width: 2048, height: 2048)
      guard let ctx = CGContext(consumer: consumer, mediaBox: &box, nil) else { return nil }
      ctx.beginPDFPage(nil)
      ctx.setFillColor(NSColor.black.cgColor)
      let drawSel = NSSelectorFromString("drawInContext:")
      guard let drawImp = class_getMethodImplementation(object_getClass(vg)!, drawSel) else { return nil }
      typealias DrawFn = @convention(c) (AnyObject, Selector, CGContext) -> Void
      unsafeBitCast(drawImp, to: DrawFn.self)(vg, drawSel, ctx)
      ctx.endPDFPage()
      ctx.closePDF()
      return [UInt8](pdfData as Data)
    }
  }
}
#endif
