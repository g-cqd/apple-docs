// swift-tools-version: 6.3
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

// Package settings aligned to g-cqd/ADJSON (operator directive — applied to EVERY target).
// `.v6` language mode ⇒ complete strict-concurrency checking; the upcoming features tighten
// existentials (`any`) + import visibility (`public import` for re-exports, direct imports for
// member use). No InlineArray/UTF8Span (2025-SDK-gated — would raise the macOS floor);
// Span/RawSpan back-deploy and stay.
let strictSettings: [SwiftSetting] = [
  .swiftLanguageMode(.v6),
  .enableUpcomingFeature("ExistentialAny"),
  .enableUpcomingFeature("InternalImportsByDefault"),
  .enableUpcomingFeature("MemberImportVisibility"),
]

// Compile-time type-check timing warnings (flag slow expressions / function bodies). These use
// unsafe flags, so they live only on the internal (non-exported) test targets.
let timingWarningFlags: [SwiftSetting] = [
  .unsafeFlags([
    "-Xfrontend", "-warn-long-function-bodies=100",
    "-Xfrontend", "-warn-long-expression-type-checking=100",
  ])
]

// Tests: strict + timing warnings + runtime actor data-race checks. (Built via `flatMap` to
// avoid a slow `+`-chain type-check of the `[SwiftSetting]` literals in the manifest.)
let actorDataRaceChecks: [SwiftSetting] = [.unsafeFlags(["-enable-actor-data-race-checks"])]
let testSettings: [SwiftSetting] = [strictSettings, timingWarningFlags, actorDataRaceChecks].flatMap { $0 }

// HTTP/3 (RFC 0007 F6) is env-gated because apple/swift-nio-http3 floors at macOS 26 — SPM
// rejects it at the macOS-15 default (verified: "NIOHTTP3 requires macOS 26, target supports
// 15"), and `@available` can't gate a link nor can `platforms:` differ per target. So a build
// with `AD_HTTP3=1` (on a 2025 SDK) RAISES the macOS floor to 26, pulls the QUIC/HTTP3 stack,
// and defines `AD_HTTP3` for the `#if AD_HTTP3` engine code; the default macOS-15 build is
// untouched (no h3 deps, no floor bump). This is the conditional-manifest pattern, not
// `@available`.
let http3 = Context.environment["AD_HTTP3"] != nil
let macOSFloor: SupportedPlatform = http3 ? .macOS("26.0") : .macOS(.v15)
let http3PackageDependencies: [Package.Dependency] =
  http3 ? [.package(url: "https://github.com/apple/swift-nio-http3.git", branch: "main")] : []
let http3TargetDependencies: [Target.Dependency] =
  http3 ? [.product(name: "NIOHTTP3", package: "swift-nio-http3")] : []
let http3Settings: [SwiftSetting] = http3 ? [.define("AD_HTTP3")] : []

let package = Package(
  name: "AppleDocsCore",
  // Aligned to g-cqd/ADJSON (operator directive): macOS one generation below the device
  // platforms. Synchronization (Mutex/Atomic) ships in macOS 15 and Span/RawSpan back-deploy,
  // so 15.0 suffices; the 2025-SDK-gated InlineArray/UTF8Span are intentionally not adopted.
  // Linux unaffected (the dylib stays cross-platform; only ad-server is Apple-native).
  platforms: [
    macOSFloor, .iOS(.v26), .tvOS(.v26), .watchOS(.v26), .visionOS(.v26),
  ],
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
    // "2.65.0"` above resolves up. NONE pulled by ADCore (the dylib stays
    // zero-external-dep). (swift-tagged is deferred with RFC 0006 H4 — re-added when
    // domain newtypes/the MCP Tool DSL actually use it.)
    .package(url: "https://github.com/apple/swift-http-types.git", from: "1.6.0"),
    .package(url: "https://github.com/apple/swift-log.git", from: "1.13.2"),
    .package(url: "https://github.com/apple/swift-nio-extras.git", from: "1.34.1"),
    // RFC 0007 F1b: TLS 1.3 (NIOSSL) + HTTP/2 (NIOHTTP2) for the per-App `Wire`.
    // Both apple/* (allow-list-clean) and already resolved transitively.
    .package(url: "https://github.com/apple/swift-nio-ssl.git", from: "2.37.0"),
    .package(url: "https://github.com/apple/swift-nio-http2.git", from: "1.44.0"),
    // RFC 0007 F3: Network.framework transport (Apple-native) — apple/*, allow-list-clean.
    .package(url: "https://github.com/apple/swift-nio-transport-services.git", from: "1.28.0"),
    // ad-server CLI flag parsing (RFC 0001 P7 groundwork): apple/swift-argument-parser
    // is §2 allow-list-clean (apple/*). Used ONLY by the ad-server executable for its
    // serve/mcp/bench subcommands; NOT pulled by ADCore (the dylib stays zero-external-dep).
    .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0")
  ] + http3PackageDependencies,
  targets: [
    .target(name: "ADBase", swiftSettings: releaseCMO + strictSettings),
    .target(name: "ADSearch", swiftSettings: releaseCMO + strictSettings),
    .target(name: "ADArchive", swiftSettings: releaseCMO + strictSettings),
    .target(name: "ADEmbed", swiftSettings: releaseCMO + strictSettings),
    // Content pipeline (RFC 0004): reuses ADEmbed's engine-derived JS
    // string semantics (CaseFolding = JS toLowerCase, jsWhitespace = JS
    // trim/\s) and ADBase's ordered JSON.
    .target(name: "ADContent", dependencies: ["ADBase", "ADEmbed"], swiftSettings: releaseCMO + strictSettings),
    // Render service (RFC 0003 P3-darwin): symbol/font renderers. darwin
    // links CoreText/AppKit; the Linux slice compiles to stubs (#if
    // canImport) so the dylib still builds with no AppKit/CoreText.
    .target(name: "ADRender", dependencies: ["ADBase"], swiftSettings: releaseCMO + strictSettings),
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
      swiftSettings: releaseCMO + strictSettings),
    // Search cascade (RFC 0001 P6): the byte-exact in-process port of the JS
    // lexical search (fts-query-builder, intent, the tier merge, ranking,
    // projection). SERVER-ONLY — used by ad-server, NOT by the libAppleDocsCore
    // dylib (which stays zero-dep). Max strict concurrency.
    .target(
      name: "ADSearchCascade", dependencies: ["ADStorage", "ADContent", "ADBase"],
      swiftSettings: releaseCMO + strictSettings),
    // Dev-only reference dump for the flipped fixture generator (RFC 0002
    // §6h); not shipped — the dylib product above is unchanged.
    .executableTarget(
      name: "ad-embed-dump", dependencies: ["ADEmbed"], path: "Sources/ADEmbedDump",
      swiftSettings: releaseCMO + strictSettings),
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
        .product(name: "NIOHTTPTypesHTTP2", package: "swift-nio-extras"),
        .product(name: "NIOSSL", package: "swift-nio-ssl"),
        .product(name: "NIOHTTP2", package: "swift-nio-http2"),
        .product(name: "NIOTransportServices", package: "swift-nio-transport-services"),
        .product(name: "HTTPTypes", package: "swift-http-types"),
        .product(name: "Logging", package: "swift-log"),
        .product(name: "Crypto", package: "swift-crypto"),
        .product(name: "ADJSON", package: "ADJSON"),
        "ADStorage",
      ] + http3TargetDependencies,
      swiftSettings: releaseCMO + strictSettings + http3Settings),
    // RFC 0005 — the endpoint DSL: @RouteBuilder, Route/Group, the typed Path
    // (RegexBuilder captures), RequestContext, RouteQuery, ResponseContent, the
    // .cache/.storage modifiers (and the Tool DSL in Phase C). Sees only
    // ADServeCore's public surface — the engine internals stay out of reach.
    .target(
      name: "ADServeDSL",
      dependencies: [
        "ADServeCore",
        .product(name: "HTTPTypes", package: "swift-http-types"),
        .product(name: "ADJSON", package: "ADJSON"),
      ],
      swiftSettings: releaseCMO + strictSettings),
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
        .product(name: "ArgumentParser", package: "swift-argument-parser"),
        "ADServeCore",
        "ADServeDSL",
        "ADStorage",
        "ADSearchCascade",
      ],
      path: "Sources/ADServer", swiftSettings: releaseCMO + strictSettings),
    .target(
      name: "ADCore",
      dependencies: ["ADBase", "ADSearch", "ADArchive", "ADEmbed", "ADContent", "ADRender", "ADStorage"],
      swiftSettings: releaseCMO + strictSettings),
    .testTarget(name: "ADBaseTests", dependencies: ["ADBase"], swiftSettings: testSettings),
    .testTarget(name: "ADSearchTests", dependencies: ["ADSearch"], swiftSettings: testSettings),
    .testTarget(name: "ADArchiveTests", dependencies: ["ADArchive"], swiftSettings: testSettings),
    .testTarget(name: "ADCoreTests", dependencies: ["ADCore", "ADEmbed"], swiftSettings: testSettings),
    .testTarget(name: "ADEmbedTests", dependencies: ["ADEmbed"], swiftSettings: testSettings),
    .testTarget(name: "ADContentTests", dependencies: ["ADContent"], swiftSettings: testSettings),
    .testTarget(name: "ADStorageTests", dependencies: ["ADStorage"], swiftSettings: testSettings),
  ]
)
