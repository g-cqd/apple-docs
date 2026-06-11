// swift-tools-version: 6.1
// libAppleDocsCore — the Swift side of the bridge era (RFC 0001 §4).
// Zero dependencies by policy; ABI contract v0 (rfcs/.../p0/ffi-bridge.md).
import PackageDescription

let package = Package(
  name: "AppleDocsCore",
  // Floor matches the repo's stated macOS 13+ support; without it the
  // toolchain defaults the deployment target to the SDK (macOS 27), which
  // would refuse to load on the macOS 26 production host and deprecates
  // the x86_64 slice the universal artifact exists for.
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "AppleDocsCore", type: .dynamic, targets: ["ADCore"])
  ],
  targets: [
    .target(name: "ADBase"),
    .target(name: "ADSearch"),
    .target(name: "ADArchive"),
    .target(name: "ADCore", dependencies: ["ADBase", "ADSearch", "ADArchive"]),
    .testTarget(name: "ADBaseTests", dependencies: ["ADBase"]),
    .testTarget(name: "ADSearchTests", dependencies: ["ADSearch"]),
    .testTarget(name: "ADArchiveTests", dependencies: ["ADArchive"]),
    .testTarget(name: "ADCoreTests", dependencies: ["ADCore"]),
  ]
)
