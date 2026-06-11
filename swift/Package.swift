// swift-tools-version: 6.1
// libAppleDocsCore — the Swift side of the bridge era (RFC 0001 §4).
// Zero dependencies by policy; ABI contract v0 (rfcs/.../p0/ffi-bridge.md).
import PackageDescription

let package = Package(
  name: "AppleDocsCore",
  products: [
    .library(name: "AppleDocsCore", type: .dynamic, targets: ["ADCore"])
  ],
  targets: [
    .target(name: "ADBase"),
    .target(name: "ADSearch"),
    .target(name: "ADCore", dependencies: ["ADBase", "ADSearch"]),
    .testTarget(name: "ADBaseTests", dependencies: ["ADBase"]),
    .testTarget(name: "ADSearchTests", dependencies: ["ADSearch"]),
    .testTarget(name: "ADCoreTests", dependencies: ["ADCore"]),
  ]
)
