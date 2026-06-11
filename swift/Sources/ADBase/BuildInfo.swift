/// Foundation-free build-info JSON for `ad_build_info` (loader diagnostics).
public enum BuildInfo {
  public static func json(abi: UInt32) -> String {
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
    return #"{"abi":\#(abi),"platform":"\#(platform)","arch":"\#(arch)","compiler":"\#(compiler)"}"#
  }
}
