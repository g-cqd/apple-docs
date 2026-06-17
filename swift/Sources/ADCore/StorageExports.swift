// Storage FFI surface. Byte layouts are shared verbatim — change both sides
// together.
// The read path runs INSIDE the bun:sqlite reader-pool workers (blocking
// FFI on a worker thread is safe); the bun:sqlite writer is untouched.
//
// Nullable strings: [u32 len][utf8], len = 0xFFFFFFFF meaning null.
// Nullable u64:     [u64], value = 0xFFFFFFFFFFFFFFFF meaning null.
//
// ad_storage_open request:  [u32 version=1][nullable dbPath]
//   result payload (bytes): [u64 handle]  (.internalError if the dlopen'd
//   libsqlite3 / FTS5 / file is unavailable → JS bun:sqlite serves).
//
// ad_storage_close request: [u32 version=1][u64 handle]
//   result payload: empty.
//
// ad_storage_search_pages request:
//   [u32 version=1][u64 handle][nullable query][nullable raw][u32 limit]
//   then the filter bag (buildFilterParams order):
//     nullable framework, source_type, sources_json, kind, language,
//     nullable-u64 year, nullable track_like, nullable deprecated_mode,
//     nullable-u64 min_ios, min_macos, min_watchos, min_tvos, min_visionos
//   result payload (bytes): [u32 columnCount][u32 rowCount] then per row
//   columnCount cells of [u8 tag][value] —
//     0 NULL, 1 INTEGER [i64 LE], 2 REAL [f64 LE], 3 TEXT [u32 len][utf8],
//     4 BLOB [u32 len][bytes] — reproducing bun:sqlite's row objects exactly.

import ADBase
import ADStorage

private let nullU64Sentinel: UInt64 = 0xFFFF_FFFF_FFFF_FFFF

// Returns (Int64?)? — outer nil = truncated, .some(nil) = SQL null.
private func u64Field(_ r: inout RequestReader) -> (Int64?)? {
  guard let v = r.u64() else { return nil }
  if v == nullU64Sentinel { return .some(nil) }
  return .some(Int64(bitPattern: v))
}

@_cdecl("ad_storage_open")
public func adStorageOpen(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported storage request version")
  }
  guard let pathField = reader.nullableString(max: maxInputBytes) else {
    return ResultBuffer.error(.invalidInput, "truncated dbPath")
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  guard let path = pathField else {
    return ResultBuffer.error(.invalidInput, "null dbPath")
  }
  guard let handle = Storage.open(path: path) else {
    return ResultBuffer.error(.internalError, "sqlite unavailable for \(path)")
  }
  var le = handle.littleEndian
  return withUnsafeBytes(of: &le) { ResultBuffer.make(status: .ok, format: .bytes, payload: $0) }
}

@_cdecl("ad_storage_close")
public func adStorageClose(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1, let handle = reader.u64() else {
    return ResultBuffer.error(.invalidInput, "malformed close request")
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  Storage.close(handle)
  return ResultBuffer.make(status: .ok, format: .bytes, payload: nil)
}

@_cdecl("ad_storage_search_pages")
public func adStorageSearchPages(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1, let handle = reader.u64() else {
    return ResultBuffer.error(.invalidInput, "malformed search request header")
  }
  guard let queryField = reader.nullableString(max: maxInputBytes),
    let rawField = reader.nullableString(max: maxInputBytes), let limit = reader.u32()
  else {
    return ResultBuffer.error(.invalidInput, "truncated search query")
  }
  guard let framework = reader.nullableString(max: maxInputBytes),
    let sourceType = reader.nullableString(max: maxInputBytes),
    let sourcesJson = reader.nullableString(max: maxInputBytes), let kind = reader.nullableString(max: maxInputBytes),
    let language = reader.nullableString(max: maxInputBytes),
    let year = u64Field(&reader), let trackLike = reader.nullableString(max: maxInputBytes),
    let deprecatedMode = reader.nullableString(max: maxInputBytes), let minIos = u64Field(&reader),
    let minMacos = u64Field(&reader), let minWatchos = u64Field(&reader),
    let minTvos = u64Field(&reader), let minVisionos = u64Field(&reader)
  else {
    return ResultBuffer.error(.invalidInput, "truncated filter bag")
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes")
  }
  guard let query = queryField, let raw = rawField else {
    return ResultBuffer.error(.invalidInput, "null query")
  }
  let params = SearchPagesParams(
    query: query, raw: raw, limit: Int64(limit), framework: framework, sourceType: sourceType,
    sourcesJson: sourcesJson, kind: kind, language: language, year: year, trackLike: trackLike,
    deprecatedMode: deprecatedMode ?? "include", minIos: minIos, minMacos: minMacos,
    minWatchos: minWatchos, minTvos: minTvos, minVisionos: minVisionos)
  guard let bytes = Storage.searchPages(handle: handle, params) else {
    return ResultBuffer.error(.internalError, "searchPages failed (unknown handle or step error)")
  }
  return bytes.withUnsafeBytes { ResultBuffer.make(status: .ok, format: .bytes, payload: $0) }
}
