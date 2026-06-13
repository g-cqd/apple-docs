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

private func readRenderString(_ reader: inout RequestReader) -> String?? {
  guard let length = reader.u32() else { return nil } // malformed
  if length == nullSentinel { return .some(nil) }
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

// ad_render_symbol_png request:
//   [u32 version=1][nullable name][nullable scope][f64 pointSize]
//   [nullable color][nullable background][nullable weight][nullable scale]
// result payload: PNG bytes (.bytes). darwin-only (AppKit NSBitmap);
// non-darwin / failure → .invalidInput → JS spawn fallback. D-0003-3 Probe B.
@_cdecl("ad_render_symbol_png")
public func adRenderSymbolPng(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported render request version")
  }
  guard let nameField = readRenderString(&reader), let scopeField = readRenderString(&reader),
    let pointSize = reader.f64(), let colorField = readRenderString(&reader),
    let backgroundField = readRenderString(&reader), let weightField = readRenderString(&reader),
    let scaleField = readRenderString(&reader)
  else { return ResultBuffer.error(.invalidInput, "truncated symbol-png request") }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  guard let name = nameField, let scope = scopeField else {
    return ResultBuffer.error(.invalidInput, "null symbol name or scope")
  }

  #if canImport(AppKit)
  guard let png = SymbolPng.render(
    name: name, scope: scope, pointSize: pointSize, color: colorField, background: backgroundField,
    weight: weightField ?? "regular", scale: scaleField ?? "medium")
  else {
    return ResultBuffer.error(.invalidInput, "symbol-png render produced no output")
  }
  return png.withUnsafeBytes { ResultBuffer.make(status: .ok, format: .bytes, payload: $0) }
  #else
  return ResultBuffer.error(.invalidInput, "render unavailable: no AppKit on this platform")
  #endif
}

private struct SymbolJob: Sendable {
  let name: String?
  let scope: String?
  let weight: String
  let scale: String
}

// ad_render_symbol_pdf_batch request (RFC 0003 phase 2 — prerender switch):
//   [u32 version=1][u32 count] then per item:
//     [nullable name][nullable scope][nullable weight][nullable scale]
// result payload: count × [u32 len][vector PDF bytes], len 0xFFFFFFFF for an
// entry that didn't render (symbol absent / bitmap-only / failure) — the JS
// side spawns THAT symbol to classify it. darwin-only (AppKit); a non-darwin
// build returns every entry null → the JS prerender uses its worker pool.
@_cdecl("ad_render_symbol_pdf_batch")
public func adRenderSymbolPdfBatch(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported render request version")
  }
  guard let count = reader.u32(), count <= 1 << 16 else {
    return ResultBuffer.error(.invalidInput, "symbol count out of bounds")
  }
  var jobs: [SymbolJob] = []
  jobs.reserveCapacity(Int(count))
  for _ in 0..<count {
    guard let nameField = readRenderString(&reader), let scopeField = readRenderString(&reader),
      let weightField = readRenderString(&reader), let scaleField = readRenderString(&reader)
    else { return ResultBuffer.error(.invalidInput, "truncated symbol-pdf batch item") }
    jobs.append(SymbolJob(
      name: nameField, scope: scopeField,
      weight: weightField ?? "regular", scale: scaleField ?? "medium"))
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }

  #if canImport(AppKit)
  let frozen = jobs
  let results = renderIndexed(frozen.count) { i, out in
    guard let name = frozen[i].name, let scope = frozen[i].scope,
      let pdf = SymbolPdf.render(name: name, scope: scope, weight: frozen[i].weight, scale: frozen[i].scale)
    else { return false }
    out = pdf
    return true
  }
  #else
  let results = [[UInt8]?](repeating: nil, count: jobs.count)
  #endif
  return lenPrefixedPayload(results)
}
