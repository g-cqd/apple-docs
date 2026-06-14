// libAppleDocsCore mandatory exports (ABI contract v0, ffi-bridge.md §2).
// No-trap rule: nothing here may abort on input — validate, return status.

public import ADBase

let abiVersion: UInt32 = 1
let maxInputBytes = 1 << 30

@_cdecl("ad_abi_version")
public func adAbiVersion() -> UInt32 { abiVersion }

@_cdecl("ad_build_info")
public func adBuildInfo() -> UnsafeMutableRawPointer? {
  ResultBuffer.text(status: .ok, format: .json, BuildInfo.json(abi: abiVersion))
}

@_cdecl("ad_free")
public func adFree(_ ptr: UnsafeMutableRawPointer?) {
  ResultBuffer.free(ptr)
}

/// Loader self-test: byte round-trip proving load/copy/free end to end.
@_cdecl("ad_echo")
public func adEcho(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len >= 0, len <= maxInputBytes else {
    return ResultBuffer.error(.invalidInput, "invalid length \(len)")
  }
  guard len == 0 || ptr != nil else {
    return ResultBuffer.error(.invalidInput, "null pointer with length \(len)")
  }
  return ResultBuffer.make(status: .ok, format: .bytes, payload: UnsafeRawBufferPointer(start: ptr, count: len))
}
