// swift-tools-version: 6.1
// libAppleDocsCore — the Swift side of the bridge era (RFC 0001 §4).
// Zero dependencies by policy; ABI contract v0 (rfcs/.../p0/ffi-bridge.md).
import PackageDescription

// Release builds inline across module boundaries (RFC 0004 §6b): the
// content hot path calls tiny ADBase tape accessors from ADContent, and
// without CMO every one is an opaque cross-module call. Root package, so
// unsafeFlags is legal; debug/test builds are unaffected.
let releaseCMO: [SwiftSetting] = [
  .unsafeFlags(["-cross-module-optimization"], .when(configuration: .release))
]

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
    .target(name: "ADBase", swiftSettings: releaseCMO),
    .target(name: "ADSearch", swiftSettings: releaseCMO),
    .target(name: "ADArchive", swiftSettings: releaseCMO),
    .target(name: "ADEmbed", swiftSettings: releaseCMO),
    // Content pipeline (RFC 0004): reuses ADEmbed's engine-derived JS
    // string semantics (CaseFolding = JS toLowerCase, jsWhitespace = JS
    // trim/\s) and ADBase's ordered JSON.
    .target(name: "ADContent", dependencies: ["ADBase", "ADEmbed"], swiftSettings: releaseCMO),
    // Render service (RFC 0003 P3-darwin): symbol/font renderers. darwin
    // links CoreText/AppKit; the Linux slice compiles to stubs (#if
    // canImport) so the dylib still builds with no AppKit/CoreText.
    .target(name: "ADRender", dependencies: ["ADBase"], swiftSettings: releaseCMO),
    // Storage layer (RFC 0001 P5): SQLite C-interop via runtime dlopen
    // (NOT a systemLibrary — same policy as ADArchive/Zstd: absent → JS
    // bun:sqlite serves). The read path; the bun:sqlite writer is untouched.
    .target(name: "ADStorage", dependencies: ["ADBase"], swiftSettings: releaseCMO),
    // Dev-only reference dump for the flipped fixture generator (RFC 0002
    // §6h); not shipped — the dylib product above is unchanged.
    .executableTarget(name: "ad-embed-dump", dependencies: ["ADEmbed"], path: "Sources/ADEmbedDump"),
    .target(
      name: "ADCore",
      dependencies: ["ADBase", "ADSearch", "ADArchive", "ADEmbed", "ADContent", "ADRender", "ADStorage"],
      swiftSettings: releaseCMO),
    .testTarget(name: "ADBaseTests", dependencies: ["ADBase"]),
    .testTarget(name: "ADSearchTests", dependencies: ["ADSearch"]),
    .testTarget(name: "ADArchiveTests", dependencies: ["ADArchive"]),
    .testTarget(name: "ADCoreTests", dependencies: ["ADCore", "ADEmbed"]),
    .testTarget(name: "ADEmbedTests", dependencies: ["ADEmbed"]),
    .testTarget(name: "ADContentTests", dependencies: ["ADContent"]),
    .testTarget(name: "ADStorageTests", dependencies: ["ADStorage"]),
  ]
)
