/**
 * SYMBOL_PNG_SCRIPT — one-shot AppKit renderer for the SF Symbol PNG
 * fallback path. Used when the request format is png and the SVG snapshot
 * isn't available (or rasterization failed). Composes the symbol image
 * through NSGraphicsContext into a 2× sRGB bitmap and writes PNG bytes to
 * stdout. Honors weight/scale only for system symbols — private bundle
 * images come back as plain NSImages and ignore NSSymbolConfiguration.
 */
export const SYMBOL_PNG_SCRIPT = `
import AppKit
import Foundation
let name = CommandLine.arguments[1]
let scope = CommandLine.arguments[2]
let pointSize = CGFloat(Double(CommandLine.arguments[3]) ?? 64)
let color = NSColor(hex: CommandLine.arguments[4]) ?? .labelColor
let backgroundArg = CommandLine.arguments.count > 5 ? CommandLine.arguments[5] : ""
let background: NSColor? = backgroundArg.isEmpty ? nil : NSColor(hex: backgroundArg)
let weightArg = CommandLine.arguments.count > 6 ? CommandLine.arguments[6] : "regular"
let scaleArg = CommandLine.arguments.count > 7 ? CommandLine.arguments[7] : "medium"
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
let image: NSImage?
if scope == "private" {
  let paths = [
    "/System/Library/CoreServices/CoreGlyphsPrivate.bundle",
    "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphsPrivate.bundle"
  ]
  image = paths.lazy.compactMap { Bundle(path: $0)?.image(forResource: name) }.first
} else {
  image = NSImage(systemSymbolName: name, accessibilityDescription: nil)
}
guard let base = image else { FileHandle.standardError.write(Data("symbol not found".utf8)); exit(2) }
// withSymbolConfiguration only honours weight/scale for system symbols.
// Private bundle images are plain NSImages — applying the configuration
// returns them unchanged.
let configured = scope == "public"
  ? (base.withSymbolConfiguration(.init(pointSize: pointSize, weight: parseWeight(weightArg), scale: parseScale(scaleArg))) ?? base)
  : base
let px = Int((pointSize * 2).rounded())
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(3) }
rep.size = NSSize(width: pointSize, height: pointSize)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
if let bg = background {
  bg.setFill()
} else {
  NSColor.clear.setFill()
}
NSRect(x: 0, y: 0, width: pointSize, height: pointSize).fill()
color.set()
let fit = min(pointSize / configured.size.width, pointSize / configured.size.height)
let draw = NSRect(x: (pointSize - configured.size.width * fit) / 2, y: (pointSize - configured.size.height * fit) / 2, width: configured.size.width * fit, height: configured.size.height * fit)
configured.draw(in: draw, from: .zero, operation: .sourceOver, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let data = rep.representation(using: .png, properties: [:]) else { exit(4) }
FileHandle.standardOutput.write(data)
extension NSColor {
  convenience init?(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
    let r, g, b, a: CGFloat
    if s.count == 8 {
      r = CGFloat((v >> 24) & 0xff) / 255
      g = CGFloat((v >> 16) & 0xff) / 255
      b = CGFloat((v >> 8) & 0xff) / 255
      a = CGFloat(v & 0xff) / 255
    } else {
      r = CGFloat((v >> 16) & 0xff) / 255
      g = CGFloat((v >> 8) & 0xff) / 255
      b = CGFloat(v & 0xff) / 255
      a = 1
    }
    self.init(srgbRed: r, green: g, blue: b, alpha: a)
  }
}
`
