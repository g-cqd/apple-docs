// P0 probe — exercises ABI contract v0 end to end (../../ffi-bridge.md).
//
// Contract recap: every buffer-returning export hands back one Swift-malloc'ed
// allocation with a 16-byte header [u64 payloadLen LE][u32 status LE]
// [u8 formatId][3 reserved], payload at offset 16. JS copies, then calls
// ad_free exactly once. Exported functions never trap on input — they
// validate and return a status (an abort in the dylib would defeat the
// JS-fallback kill switch).

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif
// P0_NO_FOUNDATION builds a stdlib-only variant (experiment E6: measures
// the minimal runtime set a Foundation-free .so needs on Linux). The full
// Foundation umbrella is deliberate: JSONSerialization is not exported by
// FoundationEssentials (Codable only), and the probe measures the legacy
// API as the worst case.
#if !P0_NO_FOUNDATION
import Foundation
#endif

private let abiVersion: UInt32 = 1
private let maxInputBytes = 1 << 30

private enum Status: UInt32 {
  case ok = 0
  case invalidInput = 1
  case internalError = 2
}

private enum Format: UInt8 {
  case bytes = 0
  case utf8 = 1
  case json = 2
}

private func makeBuffer(
  status: Status, format: Format, payload: UnsafeRawBufferPointer?
) -> UnsafeMutableRawPointer? {
  let count = payload?.count ?? 0
  guard let base = malloc(16 + count) else { return nil }
  memset(base, 0, 16)
  base.storeBytes(of: UInt64(count).littleEndian, toByteOffset: 0, as: UInt64.self)
  base.storeBytes(of: status.rawValue.littleEndian, toByteOffset: 8, as: UInt32.self)
  base.storeBytes(of: format.rawValue, toByteOffset: 12, as: UInt8.self)
  if let payload, let src = payload.baseAddress, count > 0 {
    memcpy(base + 16, src, count)
  }
  return base
}

private func stringBuffer(
  status: Status, format: Format, _ text: String
) -> UnsafeMutableRawPointer? {
  var text = text
  return text.withUTF8 { makeBuffer(status: status, format: format, payload: UnsafeRawBufferPointer($0)) }
}

private func errBuffer(_ status: Status, _ message: String) -> UnsafeMutableRawPointer? {
  stringBuffer(status: status, format: .utf8, message)
}

@_cdecl("ad_abi_version")
public func adAbiVersion() -> UInt32 { abiVersion }

@_cdecl("ad_noop")
public func adNoop() {}

@_cdecl("ad_add")
public func adAdd(_ a: Int32, _ b: Int32) -> Int32 { a &+ b }

@_cdecl("ad_fnv1a")
public func adFnv1a(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UInt64 {
  var hash: UInt64 = 0xcbf2_9ce4_8422_2325
  guard let ptr, len > 0 else { return hash }
  for i in 0..<len {
    hash = (hash ^ UInt64(ptr[i])) &* 0x0000_0100_0000_01b3
  }
  return hash
}

@_cdecl("ad_echo")
public func adEcho(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len >= 0, len <= maxInputBytes else { return errBuffer(.invalidInput, "invalid length \(len)") }
  guard len == 0 || ptr != nil else { return errBuffer(.invalidInput, "null pointer with length \(len)") }
  let payload = UnsafeRawBufferPointer(start: ptr, count: len)
  return makeBuffer(status: .ok, format: .bytes, payload: payload)
}

@_cdecl("ad_build_info")
public func adBuildInfo() -> UnsafeMutableRawPointer? {
  #if os(macOS)
  let platform = "macos"
  #elseif os(Linux)
  let platform = "linux"
  #else
  let platform = "other"
  #endif
  #if arch(arm64)
  let arch = "arm64"
  #elseif arch(x86_64)
  let arch = "x86_64"
  #else
  let arch = "other"
  #endif
  #if compiler(>=6.5)
  let compiler = ">=6.5"
  #elseif compiler(>=6.4)
  let compiler = ">=6.4"
  #elseif compiler(>=6.3)
  let compiler = ">=6.3"
  #else
  let compiler = "<6.3"
  #endif
  let json = #"{"abi":\#(abiVersion),"platform":"\#(platform)","arch":"\#(arch)","compiler":"\#(compiler)"}"#
  return stringBuffer(status: .ok, format: .json, json)
}

@_cdecl("ad_json_roundtrip")
public func adJsonRoundtrip(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  #if P0_NO_FOUNDATION
  return errBuffer(.internalError, "built without Foundation")
  #else
  guard len > 0, len <= maxInputBytes else { return errBuffer(.invalidInput, "invalid length \(len)") }
  guard let ptr else { return errBuffer(.invalidInput, "null pointer") }
  let data = Data(bytes: ptr, count: len)
  do {
    let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    // No .fragmentsAllowed on write (FoundationEssentials' WritingOptions
    // lacks it), and Darwin *raises* on invalid top-level objects instead of
    // throwing — guard explicitly to honor the no-trap rule.
    guard JSONSerialization.isValidJSONObject(object) else {
      return errBuffer(.invalidInput, "json: top-level fragment")
    }
    let out = try JSONSerialization.data(withJSONObject: object)
    return out.withUnsafeBytes { makeBuffer(status: .ok, format: .json, payload: $0) }
  } catch {
    return errBuffer(.invalidInput, "json: \(error)")
  }
  #endif
}

// toArrayBuffer-deallocator experiment (E3 ownership variant). The trampoline
// assumes Bun passes the *payload* pointer (allocation base + 16) as the first
// argument; it must only ever run inside the isolated --dealloc-probe
// subprocess (see bench.js) so a wrong assumption cannot corrupt the main run.
private let deallocPayload: @convention(c) (
  UnsafeMutableRawPointer?, UnsafeMutableRawPointer?
) -> Void = { bytes, _ in
  if let bytes { free(bytes - 16) }
}

@_cdecl("ad_get_dealloc_fn")
public func adGetDeallocFn() -> UnsafeMutableRawPointer {
  unsafeBitCast(deallocPayload, to: UnsafeMutableRawPointer.self)
}

@_cdecl("ad_free")
public func adFree(_ ptr: UnsafeMutableRawPointer?) {
  free(ptr)
}
