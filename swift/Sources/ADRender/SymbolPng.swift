// SF Symbol → PNG. AppKit NSBitmapImageRep rasterization — DARWIN-ONLY
// (#if canImport(AppKit)); the Linux slice has no symbol here.
// Must be crash/hang-free before any caller uses it.

#if canImport(AppKit)
import AppKit
import Foundation

public enum SymbolPng {
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

  private static let privateBundlePaths = [
    "/System/Library/CoreServices/CoreGlyphsPrivate.bundle",
    "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphsPrivate.bundle",
  ]

  /// Render the symbol to PNG bytes, or nil on any failure — the JS dispatch
  /// then falls back to the spawn path exactly as a non-zero script exit
  /// would. Wrapped in an autoreleasepool (no runloop on the FFI thread to
  /// drain the NSBitmap/NSImage temporaries).
  public static func render(
    name: String, scope: String, pointSize: Double, color: String?, background: String?,
    weight: String, scale: String
  ) -> [UInt8]? {
    autoreleasepool {
      let size = CGFloat(pointSize)
      let fg = nsColor(hex: color) ?? .labelColor
      let bg: NSColor? = (background?.isEmpty ?? true) ? nil : nsColor(hex: background)

      let image: NSImage?
      if scope == "private" {
        image = privateBundlePaths.lazy.compactMap { Bundle(path: $0)?.image(forResource: name) }.first
      } else {
        image = NSImage(systemSymbolName: name, accessibilityDescription: nil)
      }
      guard let base = image else { return nil }
      // withSymbolConfiguration only honours weight/scale for system symbols;
      // private bundle images are plain NSImages and ignore the config.
      let configured =
        scope == "public"
        ? (base.withSymbolConfiguration(.init(pointSize: size, weight: parseWeight(weight), scale: parseScale(scale)))
          ?? base)
        : base
      let px = Int((size * 2).rounded())
      guard
        let rep = NSBitmapImageRep(
          bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
          samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
          bytesPerRow: 0, bitsPerPixel: 0)
      else { return nil }
      rep.size = NSSize(width: size, height: size)
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
      if let bg { bg.setFill() } else { NSColor.clear.setFill() }
      NSRect(x: 0, y: 0, width: size, height: size).fill()
      fg.set()
      let fit = min(size / configured.size.width, size / configured.size.height)
      let draw = NSRect(
        x: (size - configured.size.width * fit) / 2, y: (size - configured.size.height * fit) / 2,
        width: configured.size.width * fit, height: configured.size.height * fit)
      configured.draw(in: draw, from: .zero, operation: .sourceOver, fraction: 1)
      NSGraphicsContext.restoreGraphicsState()
      guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
      return [UInt8](data)
    }
  }

  private static func nsColor(hex: String?) -> NSColor? {
    guard var s = hex?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
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
    return NSColor(srgbRed: r, green: g, blue: b, alpha: a)
  }
}
#endif
