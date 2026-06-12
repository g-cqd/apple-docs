// Content FFI surface (RFC 0004 phases 1-2). Byte layouts are shared
// verbatim with src/content/content-native.js — change both sides together.
//
// Nullable strings: [u32 len][utf8] with len = 0xFFFFFFFF meaning null
// (empty strings are meaningful and distinct from null).
//
// ad_content_doc_markdown request (little-endian):
//   [u32 version=1][u32 flags: bit0 includeFrontMatter, bit1 includeTitle]
//   7 × nullable string: key, title, framework, frameworkDisplay, role,
//     roleHeading, platformsJson
//   [u32 sectionCount] then per section:
//     nullable kind, nullable heading, nullable contentText,
//     nullable contentJson, [f64 sortOrder]
// result payload: markdown utf8.
//
// ad_content_plaintext request:
//   [u32 version=1]
//   4 × nullable string: title, abstractText, declarationText, headings
//   [u32 sectionCount] then per section:
//     nullable heading, nullable contentText, [f64 sortOrder]
// result payload: text utf8.
//
// ad_content_page_markdown request:
//   [u32 version=1][nullable path][nullable rawJson]
// result payload: markdown utf8. A JSON parse failure (or container
// nesting beyond 512) returns .invalidInput — the JS side falls back
// per call.
//
// ad_content_convert_pages request (the batch shape that beats JS —
// Swift owns read+parse+render, bytes never round-trip through JS):
//   [u32 version=1][u32 count] then per page:
//     nullable canonicalPath, nullable absoluteFilePath
// result payload: count × [u32 len][markdown utf8], len 0xFFFFFFFF for a
// page that failed (unreadable/malformed) — JS converts THAT page itself.

import ADBase
import ADContent

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

private let nullSentinel: UInt32 = 0xFFFF_FFFF

private func readNullableString(_ reader: inout RequestReader, max: Int = maxInputBytes) -> String?? {
  guard let length = reader.u32() else { return nil } // malformed
  if length == nullSentinel { return .some(nil) }
  guard Int(length) <= max, let view = reader.bytes(Int(length)) else { return nil }
  return .some(String(decoding: view, as: UTF8.self))
}

@_cdecl("ad_content_doc_markdown")
public func adContentDocMarkdown(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported content request version")
  }
  guard let flags = reader.u32() else {
    return ResultBuffer.error(.invalidInput, "truncated flags")
  }
  var fields: [String?] = []
  for _ in 0..<7 {
    guard let field = readNullableString(&reader) else {
      return ResultBuffer.error(.invalidInput, "truncated document field")
    }
    fields.append(field)
  }
  let document = ContentDocument(
    key: fields[0], title: fields[1], framework: fields[2], frameworkDisplay: fields[3],
    role: fields[4], roleHeading: fields[5], platformsJson: fields[6])

  guard let sectionCount = reader.u32(), sectionCount <= 1 << 20 else {
    return ResultBuffer.error(.invalidInput, "section count out of bounds")
  }
  var sections: [ContentSection] = []
  sections.reserveCapacity(Int(sectionCount))
  for _ in 0..<sectionCount {
    guard let kind = readNullableString(&reader),
      let heading = readNullableString(&reader),
      let contentText = readNullableString(&reader),
      let contentJson = readNullableString(&reader),
      let sortOrder = reader.f64()
    else { return ResultBuffer.error(.invalidInput, "truncated section") }
    sections.append(
      ContentSection(
        sectionKind: kind, heading: heading, contentText: contentText ?? "",
        contentJson: contentJson, sortOrder: sortOrder))
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  let markdown = DocMarkdown.render(
    document: document, sections: sections,
    includeFrontMatter: flags & 1 != 0, includeTitle: flags & 2 != 0)
  return ResultBuffer.text(status: .ok, format: .utf8, markdown)
}

@_cdecl("ad_content_plaintext")
public func adContentPlaintext(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported content request version")
  }
  var fields: [String?] = []
  for _ in 0..<4 {
    guard let field = readNullableString(&reader) else {
      return ResultBuffer.error(.invalidInput, "truncated document field")
    }
    fields.append(field)
  }
  let document = PlainTextDocument(
    title: fields[0], abstractText: fields[1], declarationText: fields[2], headings: fields[3])

  guard let sectionCount = reader.u32(), sectionCount <= 1 << 20 else {
    return ResultBuffer.error(.invalidInput, "section count out of bounds")
  }
  var sections: [PlainTextSection] = []
  sections.reserveCapacity(Int(sectionCount))
  for _ in 0..<sectionCount {
    guard let heading = readNullableString(&reader),
      let contentText = readNullableString(&reader),
      let sortOrder = reader.f64()
    else { return ResultBuffer.error(.invalidInput, "truncated section") }
    sections.append(
      PlainTextSection(heading: heading, contentText: contentText ?? "", sortOrder: sortOrder))
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  let text = PlainText.render(document: document, sections: sections)
  return ResultBuffer.text(status: .ok, format: .utf8, text)
}

@_cdecl("ad_content_page_markdown")
public func adContentPageMarkdown(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported content request version")
  }
  guard let pathField = readNullableString(&reader), let rawField = readNullableString(&reader) else {
    return ResultBuffer.error(.invalidInput, "truncated page request")
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  let path = pathField ?? ""
  guard let raw = rawField else {
    return ResultBuffer.error(.invalidInput, "null raw JSON")
  }
  let parsed: JsonValue
  do {
    parsed = try Json.parse(Array(raw.utf8), maxContainerDepth: 512)
  } catch {
    // JSON.parse would have thrown too — but the JS path may still differ
    // (its engine has no depth cap), so this surfaces as invalidInput and
    // the dispatch falls back to JS for the page.
    return ResultBuffer.error(.invalidInput, "page JSON rejected: \(error)")
  }
  let markdown = PageMarkdown.render(json: parsed, canonicalPath: path)
  return ResultBuffer.text(status: .ok, format: .utf8, markdown)
}

@_cdecl("ad_content_convert_pages")
public func adContentConvertPages(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported content request version")
  }
  guard let count = reader.u32(), count <= 1 << 16 else {
    return ResultBuffer.error(.invalidInput, "page count out of bounds")
  }
  var pages: [(canonicalPath: String, filePath: String)?] = []
  pages.reserveCapacity(Int(count))
  for _ in 0..<count {
    guard let canonicalPath = readNullableString(&reader),
      let filePath = readNullableString(&reader)
    else { return ResultBuffer.error(.invalidInput, "truncated page entry") }
    if let canonicalPath, let filePath {
      pages.append((canonicalPath, filePath))
    } else {
      pages.append(nil)
    }
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }

  var results: [String?] = []
  results.reserveCapacity(pages.count)
  var payloadCount = 0
  for page in pages {
    let markdown = page.flatMap {
      PageMarkdown.convertFile(absolutePath: $0.filePath, canonicalPath: $0.canonicalPath)
    }
    payloadCount += 4 + (markdown?.utf8.count ?? 0)
    results.append(markdown)
  }
  guard let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: payloadCount) else {
    return nil
  }
  var offset = 0
  for result in results {
    if var result {
      let count = result.utf8.count
      payload.storeBytes(of: UInt32(count).littleEndian, toByteOffset: offset, as: UInt32.self)
      offset += 4
      if count > 0 {
        result.withUTF8 { src in
          memcpy(payload.baseAddress! + offset, src.baseAddress!, src.count)
        }
        offset += count
      }
    } else {
      payload.storeBytes(of: nullSentinel.littleEndian, toByteOffset: offset, as: UInt32.self)
      offset += 4
    }
  }
  return base
}
