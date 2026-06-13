// Content FFI surface (RFC 0004 phases 1-2, perf round §6b). Byte layouts
// are shared verbatim with src/content/content-native.js — change both
// sides together.
//
// Nullable strings: [u32 len][utf8] with len = 0xFFFFFFFF meaning null
// (empty strings are meaningful and distinct from null). Field bytes are
// consumed as SPANS over the request buffer — valid for the duration of
// the synchronous call, which is exactly the render's lifetime.
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
// result payload: markdown utf8. JSON parse failure → .invalidInput (the
// JS side falls back per call).
//
// ad_content_convert_pages request (batch; Swift owns read+parse+render):
//   [u32 version=1][u32 count] then per page:
//     nullable canonicalPath, nullable absoluteFilePath
// result payload: count × [u32 len][markdown utf8], len 0xFFFFFFFF for a
// page that failed (unreadable/malformed) — JS converts THAT page itself.

import ADBase
import ADContent

// nullSentinel, renderIndexed, and lenPrefixedPayload are the shared
// contract-v0 batch primitives in ADBase/BatchResult.swift.

private func readNullableSpan(_ reader: inout RequestReader, max: Int = maxInputBytes) -> ByteSpan?? {
  guard let length = reader.u32() else { return nil } // malformed
  if length == nullSentinel { return .some(nil) }
  guard Int(length) <= max, let view = reader.bytes(Int(length)) else { return nil }
  return .some(view)
}

private func spanString(_ span: ByteSpan?) -> String? {
  guard let span else { return nil }
  return String(decoding: span.bindMemory(to: UInt8.self), as: UTF8.self)
}

private func payload(from bytes: [UInt8]) -> UnsafeMutableRawPointer? {
  return bytes.withUnsafeBytes { raw -> UnsafeMutableRawPointer? in
    ResultBuffer.make(status: .ok, format: .utf8, payload: ByteSpan(raw))
  }
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
  var fields: [ByteSpan?] = []
  for _ in 0..<7 {
    guard let field = readNullableSpan(&reader) else {
      return ResultBuffer.error(.invalidInput, "truncated document field")
    }
    fields.append(field)
  }
  let document = DocFieldSpans(
    key: fields[0], title: fields[1], framework: fields[2], frameworkDisplay: fields[3],
    role: fields[4], roleHeading: fields[5], platformsJson: fields[6])

  guard let sectionCount = reader.u32(), sectionCount <= 1 << 20 else {
    return ResultBuffer.error(.invalidInput, "section count out of bounds")
  }
  let empty = ByteSpan(start: nil, count: 0)
  var sections: [SectionSpans] = []
  sections.reserveCapacity(Int(sectionCount))
  for _ in 0..<sectionCount {
    guard let kind = readNullableSpan(&reader),
      let heading = readNullableSpan(&reader),
      let contentText = readNullableSpan(&reader),
      let contentJson = readNullableSpan(&reader),
      let sortOrder = reader.f64()
    else { return ResultBuffer.error(.invalidInput, "truncated section") }
    sections.append(
      SectionSpans(
        kind: kind, heading: heading, text: contentText ?? empty, json: contentJson,
        sortOrder: sortOrder))
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  var w = ByteWriter(capacity: 4096)
  var sectionW = ByteWriter(capacity: 2048)
  var out: [UInt8] = []
  DocMarkdown.render(
    document: document, sections: sections,
    includeFrontMatter: flags & 1 != 0, includeTitle: flags & 2 != 0,
    w: &w, sectionW: &sectionW, out: &out)
  return payload(from: out)
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
  var fields: [ByteSpan?] = []
  for _ in 0..<4 {
    guard let field = readNullableSpan(&reader) else {
      return ResultBuffer.error(.invalidInput, "truncated document field")
    }
    fields.append(field)
  }
  let document = PlainTextSpans(
    title: fields[0], abstractText: fields[1], declarationText: fields[2], headings: fields[3])

  guard let sectionCount = reader.u32(), sectionCount <= 1 << 20 else {
    return ResultBuffer.error(.invalidInput, "section count out of bounds")
  }
  let empty = ByteSpan(start: nil, count: 0)
  var sections: [PlainSectionSpans] = []
  sections.reserveCapacity(Int(sectionCount))
  for _ in 0..<sectionCount {
    guard let heading = readNullableSpan(&reader),
      let contentText = readNullableSpan(&reader),
      let sortOrder = reader.f64()
    else { return ResultBuffer.error(.invalidInput, "truncated section") }
    sections.append(
      PlainSectionSpans(heading: heading, text: contentText ?? empty, sortOrder: sortOrder))
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  var w = ByteWriter(capacity: 2048)
  var out: [UInt8] = []
  PlainText.render(document: document, sections: sections, w: &w, out: &out)
  return payload(from: out)
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
  guard let pathField = readNullableSpan(&reader), let rawField = readNullableSpan(&reader) else {
    return ResultBuffer.error(.invalidInput, "truncated page request")
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  let path = spanString(pathField) ?? ""
  guard let raw = rawField else {
    return ResultBuffer.error(.invalidInput, "null raw JSON")
  }
  let tape: JsonTape
  do {
    tape = try JsonTape.parse(raw, maxContainerDepth: 512)
  } catch {
    return ResultBuffer.error(.invalidInput, "page JSON rejected: \(error)")
  }
  var w = ByteWriter(capacity: 8192)
  PageMarkdown.render(tape: tape, canonicalPath: path, into: &w)
  var out: [UInt8] = []
  ByteOps.finishDocument(w.bytes, into: &out, trailingNewline: true)
  return payload(from: out)
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
    guard let canonicalPath = readNullableSpan(&reader),
      let filePath = readNullableSpan(&reader)
    else { return ResultBuffer.error(.invalidInput, "truncated page entry") }
    if let canonicalPath = spanString(canonicalPath), let filePath = spanString(filePath) {
      pages.append((canonicalPath, filePath))
    } else {
      pages.append(nil)
    }
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }

  let jobs = pages
  let results = renderIndexed(jobs.count) { i, out in
    guard let page = jobs[i] else { return false }
    var scratch = ByteWriter(capacity: 8192)
    return PageMarkdown.convertFile(
      absolutePath: page.filePath, canonicalPath: page.canonicalPath, scratch: &scratch, out: &out)
  }
  return lenPrefixedPayload(results)
}

// MARK: - Batched render exports (RFC 0004 §6b)
//
// ad_content_doc_markdown_batch request:
//   [u32 version=1][u32 flags][u32 docCount] then per doc the SAME body
//   as ad_content_doc_markdown after its flags (7 nullable fields +
//   section list). Result: docCount × [u32 len][markdown utf8].
//
// ad_content_plaintext_batch request:
//   [u32 version=1][u32 docCount] then per doc the SAME body as
//   ad_content_plaintext. Result: docCount × [u32 len][text utf8].

private struct DocJob: @unchecked Sendable {
  // Spans reference the request buffer — valid for the whole call; reads
  // are concurrent and immutable.
  let document: DocFieldSpans
  let sections: [SectionSpans]
}

private struct PlainJob: @unchecked Sendable {
  let document: PlainTextSpans
  let sections: [PlainSectionSpans]
}

private func decodeDocJob(_ reader: inout RequestReader) -> DocJob? {
  var fields: [ByteSpan?] = []
  for _ in 0..<7 {
    guard let field = readNullableSpan(&reader) else { return nil }
    fields.append(field)
  }
  let document = DocFieldSpans(
    key: fields[0], title: fields[1], framework: fields[2], frameworkDisplay: fields[3],
    role: fields[4], roleHeading: fields[5], platformsJson: fields[6])
  guard let sectionCount = reader.u32(), sectionCount <= 1 << 20 else { return nil }
  let empty = ByteSpan(start: nil, count: 0)
  var sections: [SectionSpans] = []
  sections.reserveCapacity(Int(sectionCount))
  for _ in 0..<sectionCount {
    guard let kind = readNullableSpan(&reader),
      let heading = readNullableSpan(&reader),
      let contentText = readNullableSpan(&reader),
      let contentJson = readNullableSpan(&reader),
      let sortOrder = reader.f64()
    else { return nil }
    sections.append(
      SectionSpans(
        kind: kind, heading: heading, text: contentText ?? empty, json: contentJson,
        sortOrder: sortOrder))
  }
  return DocJob(document: document, sections: sections)
}

private func decodePlainJob(_ reader: inout RequestReader) -> PlainJob? {
  var fields: [ByteSpan?] = []
  for _ in 0..<4 {
    guard let field = readNullableSpan(&reader) else { return nil }
    fields.append(field)
  }
  let document = PlainTextSpans(
    title: fields[0], abstractText: fields[1], declarationText: fields[2], headings: fields[3])
  guard let sectionCount = reader.u32(), sectionCount <= 1 << 20 else { return nil }
  let empty = ByteSpan(start: nil, count: 0)
  var sections: [PlainSectionSpans] = []
  sections.reserveCapacity(Int(sectionCount))
  for _ in 0..<sectionCount {
    guard let heading = readNullableSpan(&reader),
      let contentText = readNullableSpan(&reader),
      let sortOrder = reader.f64()
    else { return nil }
    sections.append(
      PlainSectionSpans(heading: heading, text: contentText ?? empty, sortOrder: sortOrder))
  }
  return PlainJob(document: document, sections: sections)
}

@_cdecl("ad_content_doc_markdown_batch")
public func adContentDocMarkdownBatch(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported content request version")
  }
  guard let flags = reader.u32(), let docCount = reader.u32(), docCount <= 1 << 16 else {
    return ResultBuffer.error(.invalidInput, "doc count out of bounds")
  }
  var jobs: [DocJob] = []
  jobs.reserveCapacity(Int(docCount))
  for _ in 0..<docCount {
    guard let job = decodeDocJob(&reader) else {
      return ResultBuffer.error(.invalidInput, "truncated doc entry")
    }
    jobs.append(job)
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  let includeFrontMatter = flags & 1 != 0
  let includeTitle = flags & 2 != 0
  let frozen = jobs
  let results = renderIndexed(frozen.count) { i, out in
    var w = ByteWriter(capacity: 4096)
    var sectionW = ByteWriter(capacity: 2048)
    DocMarkdown.render(
      document: frozen[i].document, sections: frozen[i].sections,
      includeFrontMatter: includeFrontMatter, includeTitle: includeTitle,
      w: &w, sectionW: &sectionW, out: &out)
    return true
  }
  return lenPrefixedPayload(results)
}

@_cdecl("ad_content_plaintext_batch")
public func adContentPlaintextBatch(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported content request version")
  }
  guard let docCount = reader.u32(), docCount <= 1 << 16 else {
    return ResultBuffer.error(.invalidInput, "doc count out of bounds")
  }
  var jobs: [PlainJob] = []
  jobs.reserveCapacity(Int(docCount))
  for _ in 0..<docCount {
    guard let job = decodePlainJob(&reader) else {
      return ResultBuffer.error(.invalidInput, "truncated doc entry")
    }
    jobs.append(job)
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  let frozen = jobs
  let results = renderIndexed(frozen.count) { i, out in
    var w = ByteWriter(capacity: 2048)
    PlainText.render(document: frozen[i].document, sections: frozen[i].sections, w: &w, out: &out)
    return true
  }
  return lenPrefixedPayload(results)
}
