// Render FFI surface (RFC 0003 phase 1). Byte layouts are shared verbatim
// with src/resources/render-native.js — change both sides together.
//
// Nullable strings: [u32 len][utf8], len 0xFFFFFFFF = null.
//
// ad_render_font_text request (little-endian):
//   [u32 version=1][nullable fontPath][nullable text][f64 pointSize]
// result payload: SVG utf8. A non-darwin build (no CoreText) or a render
// failure returns .invalidInput — the JS side falls back to the spawn /
// hb-view / placeholder chain.

import ADBase
import ADRender

#if canImport(CoreGraphics)
import CoreGraphics
#endif

private let renderNull: UInt32 = 0xFFFF_FFFF

private func readRenderString(_ reader: inout RequestReader) -> String?? {
  guard let length = reader.u32() else { return nil } // malformed
  if length == renderNull { return .some(nil) }
  guard Int(length) <= maxInputBytes, let view = reader.bytes(Int(length)) else { return nil }
  return .some(String(decoding: view, as: UTF8.self))
}

@_cdecl("ad_render_font_text")
public func adRenderFontText(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported render request version")
  }
  guard let fontPathField = readRenderString(&reader), let textField = readRenderString(&reader),
    let pointSize = reader.f64()
  else { return ResultBuffer.error(.invalidInput, "truncated font-text request") }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  guard let fontPath = fontPathField, let text = textField else {
    return ResultBuffer.error(.invalidInput, "null fontPath or text")
  }

  #if canImport(CoreText)
  guard let svg = FontText.renderSVG(fontPath: fontPath, text: text, pointSize: CGFloat(pointSize))
  else {
    return ResultBuffer.error(.invalidInput, "font-text render produced no output")
  }
  return ResultBuffer.text(status: .ok, format: .utf8, svg)
  #else
  return ResultBuffer.error(.invalidInput, "render unavailable: no CoreText on this platform")
  #endif
}

// ad_render_symbol_pdf request:
//   [u32 version=1][nullable name][nullable scope][nullable weight][nullable scale]
// result payload: vector PDF bytes (format .bytes). darwin-only (AppKit);
// non-darwin / failure → .invalidInput → JS spawn fallback.
@_cdecl("ad_render_symbol_pdf")
public func adRenderSymbolPdf(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported render request version")
  }
  guard let nameField = readRenderString(&reader), let scopeField = readRenderString(&reader),
    let weightField = readRenderString(&reader), let scaleField = readRenderString(&reader)
  else { return ResultBuffer.error(.invalidInput, "truncated symbol-pdf request") }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  guard let name = nameField, let scope = scopeField else {
    return ResultBuffer.error(.invalidInput, "null symbol name or scope")
  }
  let weight = weightField ?? "regular"
  let scale = scaleField ?? "medium"

  #if canImport(AppKit)
  guard let pdf = SymbolPdf.render(name: name, scope: scope, weight: weight, scale: scale) else {
    return ResultBuffer.error(.invalidInput, "symbol-pdf render produced no output")
  }
  return pdf.withUnsafeBytes { ResultBuffer.make(status: .ok, format: .bytes, payload: $0) }
  #else
  return ResultBuffer.error(.invalidInput, "render unavailable: no AppKit on this platform")
  #endif
}
