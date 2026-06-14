// swift-tools-version: 6.1
// libAppleDocsCore — the Swift side of the bridge era (RFC 0001 §4).
// ABI contract v0 (rfcs/.../p0/ffi-bridge.md). The library product stays
// zero-dependency; the FIRST SwiftPM dependency (apple/swift-nio — §2-allowed,
// D1) is pulled ONLY by the P6 `ad-server` executable, not by ADCore.
import PackageDescription

// Release builds inline across module boundaries (RFC 0004 §6b): the
// content hot path calls tiny ADBase tape accessors from ADContent, and
// without CMO every one is an opaque cross-module call. Root package, so
// unsafeFlags is legal; debug/test builds are unaffected.
let releaseCMO: [SwiftSetting] = [
  .unsafeFlags(["-cross-module-optimization"], .when(configuration: .release))
]

// Maximum concurrency safety for the P6 server code (operator directive):
// Swift 6 language mode + complete strict-concurrency checking in EVERY
// configuration (not just release), so all Sendable/data-race violations are
// hard errors. Applied to the ad-server target.
let strictConcurrency: [SwiftSetting] = [
  .swiftLanguageMode(.v6),
  .unsafeFlags(["-strict-concurrency=complete"]),
]

let package = Package(
  name: "AppleDocsCore",
  // Floor raised to macOS 15.6 (operator decision 2026-06-13): unlocks the
  // Synchronization framework (Mutex/Atomic) + the modern concurrency APIs
  // the P6 server leans on, while staying ≤ the macOS 26 production host
  // (the dylib still loads there; x86_64 is not deprecated until the SDK's
  // macOS 27 default, which the explicit floor still avoids). Linux unaffected.
  platforms: [.macOS("15.6")],
  products: [
    .library(name: "AppleDocsCore", type: .dynamic, targets: ["ADCore"])
  ],
  // The package's first dependency (RFC 0001 P6). apple/swift-nio is within
  // the §2 allow-list (apple/*); D1 settled on raw SwiftNIO, no Vapor. Used
  // ONLY by the ad-server executable. Package.resolved is committed.
  dependencies: [
    .package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
    // Second SwiftPM dependency (RFC 0001 P6 web slice). apple/swift-crypto is
    // §2-allowed (apple/*); used ONLY by ad-server for SHA-256 — `hashable`
    // ETags + the /data/search/*.<hash>.json artifact filenames must be
    // byte-identical to the JS `Bun.CryptoHasher('sha256').digest('hex')`. NOT
    // pulled by ADCore (the dylib stays zero-external-dep).
    .package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0"),
    // ad-server-only (RFC 0001 P6 web slice): the operator's tape-based JSON
    // engine, dogfooded for the new web-route JSON. `ADJSON.JSONEncoder` emits
    // byte-identical-to-`JSON.stringify` bytes for fixed-shape Encodable payloads
    // (escaping + integer formatting match; field order = declaration order; nil
    // Optionals omitted). Branch dep — no release tag yet; Package.resolved pins
    // the commit. NOT pulled by ADCore (the dylib stays zero-external-dep).
    .package(url: "https://github.com/g-cqd/ADJSON.git", branch: "main"),
    // RFC 0005 (server framework) — ad-server-only, all §2-compliant (apple/* +
    // pointfreeco/*). swift-http-types: type-safe HTTP headers/status; swift-log:
    // structured logging; swift-nio-extras: the NIO↔HTTPTypes HTTP/1 bridge
    // (`HTTP1ToHTTPServerCodec`) — requires swift-nio ≥ 2.94.0, so the `from:
    // "2.65.0"` above resolves up; swift-tagged: domain newtypes (pre-1.0, pinned in
    // Package.resolved). NONE pulled by ADCore (the dylib stays zero-external-dep).
    .package(url: "https://github.com/apple/swift-http-types.git", from: "1.6.0"),
    .package(url: "https://github.com/apple/swift-log.git", from: "1.13.2"),
    .package(url: "https://github.com/apple/swift-nio-extras.git", from: "1.34.1"),
    .package(url: "https://github.com/pointfreeco/swift-tagged.git", from: "0.10.0")
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
    // Tiny C shim to call the dlsym'd variadic `sqlite3_config` with the
    // correct ABI (disables the global memstatus allocator mutex — RFC 0001 P6).
    .target(name: "CSQLiteShim"),
    // Storage layer (RFC 0001 P5): SQLite C-interop via runtime dlopen
    // (NOT a systemLibrary — same policy as ADArchive/Zstd: absent → JS
    // bun:sqlite serves). The read path; the bun:sqlite writer is untouched.
    // ADArchive provides the zstd decompress used by the section codec
    // (enrichment) — both dlopen'd, so the dylib stays zero external dep.
    .target(
      name: "ADStorage", dependencies: ["ADBase", "ADArchive", "CSQLiteShim"],
      swiftSettings: releaseCMO),
    // Search cascade (RFC 0001 P6): the byte-exact in-process port of the JS
    // lexical search (fts-query-builder, intent, the tier merge, ranking,
    // projection). SERVER-ONLY — used by ad-server, NOT by the libAppleDocsCore
    // dylib (which stays zero-dep). Max strict concurrency.
    .target(
      name: "ADSearchCascade", dependencies: ["ADStorage", "ADContent", "ADBase"],
      swiftSettings: releaseCMO + strictConcurrency),
    // Dev-only reference dump for the flipped fixture generator (RFC 0002
    // §6h); not shipped — the dylib product above is unchanged.
    .executableTarget(name: "ad-embed-dump", dependencies: ["ADEmbed"], path: "Sources/ADEmbedDump"),
    // RFC 0005 — the server ENGINE (the optimizable layer): NIO bootstrap, HTTP/1.1
    // on swift-http-types, the response envelope + middleware, the `.storage`
    // offload, swift-log, and (Phase C+) the MCP JSON-RPC core + transports.
    // ad-server-only; knows nothing route-specific. Max strict concurrency.
    .target(
      name: "ADServeCore",
      dependencies: [
        .product(name: "NIOCore", package: "swift-nio"),
        .product(name: "NIOPosix", package: "swift-nio"),
        .product(name: "NIOHTTP1", package: "swift-nio"),
        .product(name: "NIOHTTPTypes", package: "swift-nio-extras"),
        .product(name: "NIOHTTPTypesHTTP1", package: "swift-nio-extras"),
        .product(name: "HTTPTypes", package: "swift-http-types"),
        .product(name: "Logging", package: "swift-log"),
        .product(name: "Crypto", package: "swift-crypto"),
        .product(name: "ADJSON", package: "ADJSON"),
        "ADStorage",
      ],
      swiftSettings: releaseCMO + strictConcurrency),
    // RFC 0005 — the endpoint DSL: @RouteBuilder, Route/Group, the typed Path
    // (RegexBuilder captures), RequestContext, RouteQuery, ResponseContent, the
    // .cache/.storage modifiers (and the Tool DSL in Phase C). Sees only
    // ADServeCore's public surface — the engine internals stay out of reach.
    .target(
      name: "ADServeDSL",
      dependencies: [
        "ADServeCore",
        .product(name: "HTTPTypes", package: "swift-http-types"),
        .product(name: "Tagged", package: "swift-tagged"),
        .product(name: "ADJSON", package: "ADJSON"),
      ],
      swiftSettings: releaseCMO + strictConcurrency),
    // P6 first slice: the in-house SwiftNIO HTTP host spike (RFC 0001 P6), now the
    // RFC 0005 app layer — endpoint declarations + Services over the engine + DSL.
    // Serves /healthz + /search + the web routes over ADStorage IN-PROCESS (no FFI).
    .executableTarget(
      name: "ad-server",
      dependencies: [
        .product(name: "NIOCore", package: "swift-nio"),
        .product(name: "NIOPosix", package: "swift-nio"),
        .product(name: "NIOHTTP1", package: "swift-nio"),
        .product(name: "Crypto", package: "swift-crypto"),
        .product(name: "ADJSON", package: "ADJSON"),
        "ADServeCore",
        "ADServeDSL",
        "ADStorage",
        "ADSearchCascade",
      ],
      path: "Sources/ADServer", swiftSettings: releaseCMO + strictConcurrency),
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
