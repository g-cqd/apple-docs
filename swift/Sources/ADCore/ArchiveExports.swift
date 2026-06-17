// Archive request codec (shared verbatim — change both sides together).
// Binary, not JSON: keeps Foundation out of the dylib (the Linux bundle
// would grow ~6× for one cold-path parse). All little-endian:
//
//   u32 codecVersion (=1)   u32 level   u32 workers   u32 fileCount
//   u32 len + bytes  sourceDir (UTF-8)
//   u32 len + bytes  outputPath (UTF-8)
//   fileCount × { u32 len + bytes }  relative paths (UTF-8, pre-sorted)
//
// Response payload: JSON {fileCount,size,zstdVersion} (emitted by
// interpolation — no parser needed). This call BLOCKS for the duration of
// the archive build; it is only ever reached from CLI snapshot tooling.

import ADArchive
import ADBase

private let archiveCodecVersion: UInt32 = 1

@_cdecl("ad_archive_tar_zst")
public func adArchiveTarZst(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))

  guard let version = reader.u32(), version == archiveCodecVersion else {
    return ResultBuffer.error(.invalidInput, "unknown archive codec version")
  }
  guard let level = reader.u32(), let workers = reader.u32(), let rawCount = reader.u32() else {
    return ResultBuffer.error(.invalidInput, "truncated archive header")
  }
  let fileCount = Int(rawCount)
  guard fileCount <= ArchiveWriter.maxFiles else {
    return ResultBuffer.error(.invalidInput, "file count \(fileCount) exceeds cap")
  }
  guard let sourceDir = reader.lengthString(max: maxInputBytes),
    let outputPath = reader.lengthString(max: maxInputBytes)
  else {
    return ResultBuffer.error(.invalidInput, "truncated archive paths")
  }
  var files = [String]()
  files.reserveCapacity(fileCount)
  for _ in 0..<fileCount {
    guard let path = reader.lengthString(max: maxInputBytes) else {
      return ResultBuffer.error(.invalidInput, "truncated file list")
    }
    files.append(path)
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes in archive request")
  }

  let request = ArchiveRequest(
    sourceDir: sourceDir, outputPath: outputPath, files: files,
    level: Int32(bitPattern: level), workers: Int32(bitPattern: workers),
  )
  switch ArchiveWriter.writeTarZst(request) {
  case .success(let done):
    let json = #"{"fileCount":\#(done.fileCount),"size":\#(done.size),"zstdVersion":\#(done.zstdVersion)}"#
    return ResultBuffer.text(status: .ok, format: .json, json)
  case .failure(let failure):
    return ResultBuffer.error(failure.isInvalidInput ? .invalidInput : .internalError, failure.message)
  }
}
