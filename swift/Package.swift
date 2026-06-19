// swift-tools-version: 6.4
// libAppleDocsCore — the Swift side of the bridge era. ABI contract v0. The library
// product depends only on the first-party g-cqd/ADJSON (its `ADJSONCore` target —
// Foundation-free, swift-syntax-free, static-linked, no runtime .so), which backs the
// content pipeline; the server stack (apple/swift-nio, etc.) is pulled ONLY by the
// `ad-server` executable, never by ADCore.
import PackageDescription

// Release builds inline across module boundaries: the
// content hot path calls tiny ADBase tape accessors from ADContent, and
// without CMO every one is an opaque cross-module call. Root package, so
// unsafeFlags is legal; debug/test builds are unaffected.
let releaseCMO: [SwiftSetting] = [
    .unsafeFlags(["-cross-module-optimization"], .when(configuration: .release))
]

// `.v6` language mode ⇒ complete strict-concurrency checking; the upcoming features tighten
// existentials (`any`) + import visibility (`public import` for re-exports, direct imports for
// member use). No InlineArray/UTF8Span (2025-SDK-gated — would raise the macOS floor);
// Span/RawSpan back-deploy and stay.
let strictSettings: [SwiftSetting] = [
    .swiftLanguageMode(.v6),
    .treatAllWarnings(as: .error),
    .enableUpcomingFeature("ExistentialAny"),
    .enableUpcomingFeature("InferIsolatedConformances"),
    .enableUpcomingFeature("InternalImportsByDefault"),
    .enableUpcomingFeature("MemberImportVisibility")
]

// Compile-time type-check timing warnings (flag slow expressions / function bodies). Unsafe flags, so
// they live only on the internal (non-exported) test targets. Both budgets are 100ms: the slow bodies
// (the renderer JSON literal, the RowCodec / archive suites) were fixed at the root — split into focused
// tests, big literals hoisted to typed `let`s, chained `#expect`s moved to the kit's typed
// `expectEqual`/`expectTrue` asserts — rather than relaxed, so a regression past 100ms is a hard error.
let timingWarningFlags: [SwiftSetting] = [
    .unsafeFlags([
        "-Xfrontend", "-warn-long-function-bodies=100",
        "-Xfrontend", "-warn-long-expression-type-checking=100"
    ])
]

// Tests: strict + timing warnings + runtime actor data-race checks. (Built via `flatMap` to
// avoid a slow `+`-chain type-check of the `[SwiftSetting]` literals in the manifest.)
let actorDataRaceChecks: [SwiftSetting] = [.unsafeFlags(["-enable-actor-data-race-checks"])]
let testSettings: [SwiftSetting] = [strictSettings, timingWarningFlags, actorDataRaceChecks].flatMap { $0 }

// HTTP/3 is env-gated because apple/swift-nio-http3 floors at macOS 26 — SPM
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

// First-party dependencies resolve from the published `main` branch by default, or from a local
// checkout when the matching PATH env var is set — an absolute or relative path of the caller's
// choice, so checkouts need not be co-located. No hardcoded relative default.
//   ADJSON_PATH       -> a local ADJSON checkout (its content pipeline + server JSON).
//   ADFOUNDATION_PATH -> consumed transitively (ADJSON now depends on ADFoundation), so set it too
//                        when building against a local ADJSON checkout.
let adjsonDependency: Package.Dependency = {
    if let path = Context.environment["ADJSON_PATH"], !path.isEmpty {
        return .package(path: path)
    }
    return .package(url: "https://github.com/g-cqd/ADJSON.git", branch: "main")
}()

let adfoundationDependency: Package.Dependency = {
    if let path = Context.environment["ADFOUNDATION_PATH"], !path.isEmpty {
        return .package(path: path)
    }
    return .package(url: "https://github.com/g-cqd/ADFoundation.git", branch: "main")
}()

// ADSQL_PATH -> the ADSQL language package (its SQL + full-text-search surface over the
// ADDB engine). Pulled ONLY by the server-side `ADSQLSearch` target (the moved
// `/search` body), never by the zero-dependency `ADCore` dylib.
let adsqlDependency: Package.Dependency = {
    if let path = Context.environment["ADSQL_PATH"], !path.isEmpty {
        return .package(path: path)
    }
    return .package(url: "https://github.com/g-cqd/ADSQL.git", branch: "main")
}()

// ADCONCURRENCY_PATH -> the zero-dependency `ADConcurrency` leaf (the shared `ResourcePool` the
// server's connection pool is now specialized from, plus the `TaskProvider`/`Clock` seams). Pulled by
// the server-side `ADServeCore` only; also resolved transitively via ADJSON's umbrella. Never by the
// zero-external-dep `ADCore` dylib.
let adconcurrencyDependency: Package.Dependency = {
    if let path = Context.environment["ADCONCURRENCY_PATH"], !path.isEmpty {
        return .package(path: path)
    }
    return .package(url: "https://github.com/g-cqd/ADConcurrency.git", branch: "main")
}()

// ADSERVE_PATH -> the extracted, persistence-agnostic HTTP server package (`ADServeCore` engine +
// `ADServeDSL` route/Tool DSL). The app binds the engine's type-erased pool to its concrete
// `StorageConnection` at the composition root (Sources/ADServer/AppConnection.swift). Resolved from a
// local checkout via `ADSERVE_PATH`, otherwise the published `main`.
let adserveDependency: Package.Dependency = {
    if let path = Context.environment["ADSERVE_PATH"], !path.isEmpty {
        return .package(path: path)
    }
    return .package(url: "https://github.com/g-cqd/ADServe.git", branch: "main")
}()

// Shared lint/format tooling (ADBuildTools: Format/Lint plugins + canonical `.swift-format`). Dev-only,
// gated behind APPLEDOCS_DEV so normal/CI dylib builds never resolve it; from a local checkout via
// `ADBUILDTOOLS_PATH`, otherwise the published `main` branch.
let isDev = Context.environment["APPLEDOCS_DEV"] != nil
let adbuildToolsDependencies: [Package.Dependency] = {
    guard isDev else { return [] }
    if let path = Context.environment["ADBUILDTOOLS_PATH"], !path.isEmpty {
        return [.package(path: path)]
    }
    return [.package(url: "https://github.com/g-cqd/ADBuildTools.git", branch: "main")]
}()

// ADTestKit — the shared AD-family testing architecture (SeededRNG, Fuzz/ByteMutator, oracles,
// async/time tools). Test-only and dev-gated, so normal/CI dylib builds never resolve it. Local
// checkout via `ADTESTKIT_PATH`, otherwise the published `main`.
let adtestkitDependencies: [Package.Dependency] = {
    guard isDev else { return [] }
    if let path = Context.environment["ADTESTKIT_PATH"], !path.isEmpty {
        return [.package(path: path)]
    }
    return [.package(url: "https://github.com/g-cqd/ADTestKit.git", branch: "main")]
}()

let package = Package(
    name: "AppleDocsCore",
    // macOS one generation below the device platforms. Synchronization (Mutex/Atomic) ships in
    // macOS 15 and Span/RawSpan back-deploy, so 15.0 suffices; the 2025-SDK-gated
    // InlineArray/UTF8Span are intentionally not adopted.
    // Linux unaffected (the dylib stays cross-platform; only ad-server is Apple-native).
    platforms: [
        macOSFloor, .iOS(.v26), .tvOS(.v26), .watchOS(.v26), .visionOS(.v26)
    ],
    products: [
        .library(name: "AppleDocsCore", type: .dynamic, targets: ["ADCore"]),
        // ad-cli — the native read CLI (P7). Mirrors the Bun cli.js read verbs
        // 1:1 over ADStorage. Its own executable target (separate @main from
        // ad-server). swift-argument-parser only; no new external dep.
        .executable(name: "ad-cli", targets: ["ADCLI"])
    ],
    // apple/swift-nio: used ONLY by the ad-server executable. Package.resolved is committed.
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
        // apple/swift-crypto: used ONLY by ad-server for SHA-256 — `hashable`
        // ETags + the /data/search/*.<hash>.json artifact filenames must be
        // byte-identical to the JS `Bun.CryptoHasher('sha256').digest('hex')`. NOT
        // pulled by ADCore (the dylib stays zero-external-dep).
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.0.0"),
        // The first-party tape JSON engine (g-cqd/ADJSON). Its `ADJSONCore` target
        // (Foundation- and swift-syntax-free, static) backs the content pipeline
        // (ADContent → ADCore → the dylib): the one dependency ADCore carries, static-linked,
        // so no third-party runtime .so ships. The umbrella `ADJSON` (adds @Schemable + the
        // `JSON.stringify`-identical `JSONEncoder`) is ad-server-only. Local checkout or pinned
        // main via `ADJSON_PATH` (see above). ADFoundation's zero-dep `ADFCore` is the other static dep.
        adjsonDependency,
        adfoundationDependency,
        adsqlDependency,
        adconcurrencyDependency,
        adserveDependency,
        // ad-server-only. swift-http-types: type-safe HTTP headers/status; swift-log:
        // structured logging; swift-nio-extras: the NIO↔HTTPTypes HTTP/1 bridge
        // (`HTTP1ToHTTPServerCodec`) — requires swift-nio ≥ 2.94.0, so the `from:
        // "2.65.0"` above resolves up. NONE pulled by ADCore (the dylib stays
        // zero-external-dep).
        .package(url: "https://github.com/apple/swift-http-types.git", from: "1.6.0"),
        .package(url: "https://github.com/apple/swift-log.git", from: "1.13.2"),
        .package(url: "https://github.com/apple/swift-nio-extras.git", from: "1.34.1"),
        // TLS 1.3 (NIOSSL) + HTTP/2 (NIOHTTP2) for the per-App `Wire`.
        // Both apple/* and already resolved transitively.
        .package(url: "https://github.com/apple/swift-nio-ssl.git", from: "2.37.0"),
        .package(url: "https://github.com/apple/swift-nio-http2.git", from: "1.44.0"),
        // Network.framework transport (Apple-native).
        .package(url: "https://github.com/apple/swift-nio-transport-services.git", from: "1.28.0"),
        // apple/swift-argument-parser: used ONLY by the ad-server executable for its
        // serve/mcp/bench subcommands; NOT pulled by ADCore (the dylib stays zero-external-dep).
        .package(url: "https://github.com/apple/swift-argument-parser.git", from: "1.5.0"),
        // apple/swift-collections — already resolved (1.6.0) transitively, so a direct dep
        // adds no download or supply-chain surface. Used by the server side only
        // (ADSearchCascade: OrderedSet for the FTS term builder); NOT pulled by ADCore
        // (the dylib stays zero-external-dep).
        .package(url: "https://github.com/apple/swift-collections.git", from: "1.1.0"),
        // apple/swift-algorithms — already resolved transitively (zero new download). Used by
        // ADSearchCascade only (bounded top-K via min(count:sortedBy:)); NOT pulled by ADCore
        // (the dylib stays zero-external-dep).
        .package(url: "https://github.com/apple/swift-algorithms.git", from: "1.2.0"),
        // swift-server/swift-service-lifecycle — already resolved transitively. Used by
        // ADServeCore only (ServiceGroup graceful shutdown); NOT pulled by ADCore
        // (the dylib stays zero-external-dep).
        .package(url: "https://github.com/swift-server/swift-service-lifecycle.git", from: "2.6.0")
    ] + http3PackageDependencies + adbuildToolsDependencies + adtestkitDependencies,
    targets: [
        .target(
            name: "ADBase",
            dependencies: [.product(name: "ADFCore", package: "ADFoundation")],
            swiftSettings: releaseCMO + strictSettings),
        .target(name: "ADSearch", swiftSettings: releaseCMO + strictSettings),
        .target(name: "ADArchive", swiftSettings: releaseCMO + strictSettings),
        .target(
            name: "ADEmbed", dependencies: [.product(name: "ADFUnicode", package: "ADFoundation")],
            swiftSettings: releaseCMO + strictSettings),
        // Content pipeline: reuses ADFoundation's engine-derived JS string semantics (via ADFUnicode)
        // (CaseFolding = JS toLowerCase, jsWhitespace = JS trim/\s). The DocC JSON is
        // parsed + walked via g-cqd/ADJSON's `ADJSONCore` tape (Foundation-free, static —
        // it links into libAppleDocsCore with no third-party runtime dependency).
        .target(
            name: "ADContent",
            dependencies: [
                "ADBase", "ADEmbed",
                .product(name: "ADJSONCore", package: "ADJSON"),
                .product(name: "ADFUnicode", package: "ADFoundation"),
                .product(name: "ADFCore", package: "ADFoundation")
            ],
            swiftSettings: releaseCMO + strictSettings),
        // Render service: symbol/font renderers. darwin links CoreText/AppKit;
        // the Linux slice compiles to stubs (#if canImport) so the dylib still
        // builds with no AppKit/CoreText.
        .target(name: "ADRender", dependencies: ["ADBase"], swiftSettings: releaseCMO + strictSettings),
        // Tiny C shim to call the dlsym'd variadic `sqlite3_config` with the
        // correct ABI (disables the global memstatus allocator mutex).
        .target(name: "CSQLiteShim"),
        // Storage layer: SQLite C-interop via runtime dlopen (NOT a systemLibrary —
        // same policy as ADArchive/Zstd: absent → JS bun:sqlite serves). The read
        // path; the bun:sqlite writer is untouched. ADArchive provides the zstd
        // decompress used by the section codec (enrichment) — both dlopen'd, so
        // the dylib stays zero external dep.
        .target(
            name: "ADStorage",
            dependencies: ["ADBase", "ADArchive", "CSQLiteShim", .product(name: "ADJSONCore", package: "ADJSON")],
            swiftSettings: releaseCMO + strictSettings),
        // Search cascade: the byte-exact in-process port of the JS lexical search
        // (fts-query-builder, intent, the tier merge, ranking, projection).
        // SERVER-ONLY — used by ad-server, NOT by the libAppleDocsCore dylib
        // (which stays zero-dep). Max strict concurrency.
        .target(
            name: "ADSearchCascade",
            dependencies: [
                "ADStorage", "ADContent", "ADBase",
                .product(name: "ADFCore", package: "ADFoundation"),
                .product(name: "ADFText", package: "ADFoundation"),
                .product(name: "OrderedCollections", package: "swift-collections"),
                .product(name: "Algorithms", package: "swift-algorithms"),
                .product(name: "ADJSONCore", package: "ADJSON")
            ],
            swiftSettings: releaseCMO + strictSettings),
        // Dev-only reference dump for the flipped fixture generator; not shipped —
        // the dylib product above is unchanged.
        .executableTarget(
            name: "ad-embed-dump", dependencies: ["ADEmbed"], path: "Sources/ADEmbedDump",
            swiftSettings: releaseCMO + strictSettings),
        // The server ENGINE (`ADServeCore`) + the route/Tool DSL (`ADServeDSL`) were extracted into
        // the standalone, persistence-agnostic `ADServe` package and are consumed via its products by
        // `ad-server` below. They are no longer apple-docs targets. (The HTTP/3 conditional that gated
        // those targets is now dormant — `ADServe` will carry it if/when h3 is adopted there.)
        // The app layer — endpoint declarations + Services over the engine + DSL.
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
                .product(name: "ADServeCore", package: "ADServe"),
                .product(name: "ADServeDSL", package: "ADServe"),
                "ADStorage",
                "ADContent",
                "ADRender",
                "ADSearchCascade",
                "ADSQLSearch"
            ],
            path: "Sources/ADServer", swiftSettings: releaseCMO + strictSettings),
        // ad-cli — the native read CLI (P7: `frameworks` + `kinds` + `browse` + `read`).
        // Byte-for-byte output-compatible with the Bun cli.js read verbs. Reads via
        // ADStorage; ADContent supplies the String markdown renderer the `read` verb
        // shares with ad-server's read_doc (DocMarkdown.render, the parity-proven
        // path). A tiny local JSON model frames the `--json` output (no ADJSON
        // needed). swift-argument-parser only — no new external dependency.
        .executableTarget(
            name: "ADCLI",
            dependencies: [
                "ADStorage",
                "ADContent",
                .product(name: "ArgumentParser", package: "swift-argument-parser")
            ],
            path: "Sources/ADCLI", swiftSettings: releaseCMO + strictSettings),
        // ADSQLSearch — apple-docs' `/search` serving over the in-process ADDB engine
        // (the Swift body of the `ad_storage_search_pages` ABI): builds the main query,
        // binds the filter bag, frames the projection into the response bytes. Moved here
        // from the ADSQL package — it is apple-docs domain, not generic SQL. SERVER-ONLY:
        // used by ad-server, NEVER by the `ADCore` dylib (which stays zero-external-dep).
        .target(
            name: "ADSQLSearch",
            dependencies: [
                .product(name: "ADSQL", package: "ADSQL"),
                .product(name: "ADSQLFullTextSearch", package: "ADSQL")
            ],
            swiftSettings: releaseCMO + strictSettings),
        .target(
            name: "ADCore",
            dependencies: [
                "ADBase", "ADSearch", "ADArchive", "ADEmbed", "ADContent", "ADRender", "ADStorage",
                .product(name: "ADFCore", package: "ADFoundation")
            ],
            swiftSettings: releaseCMO + strictSettings),
        .testTarget(name: "ADBaseTests", dependencies: ["ADBase"], swiftSettings: testSettings),
        .testTarget(name: "ADSearchTests", dependencies: ["ADSearch"], swiftSettings: testSettings),
        .testTarget(name: "ADArchiveTests", dependencies: ["ADArchive"], swiftSettings: testSettings),
        .testTarget(name: "ADCoreTests", dependencies: ["ADCore", "ADEmbed"], swiftSettings: testSettings),
        .testTarget(
            name: "ADEmbedTests",
            dependencies: ["ADEmbed", .product(name: "ADFUnicode", package: "ADFoundation")],
            swiftSettings: testSettings),
        .testTarget(
            name: "ADContentTests",
            dependencies: ["ADContent", .product(name: "ADJSONCore", package: "ADJSON")],
            swiftSettings: testSettings),
        .testTarget(name: "ADStorageTests", dependencies: ["ADStorage"], swiftSettings: testSettings),
        .testTarget(
            name: "ADSearchCascadeTests", dependencies: ["ADSearchCascade"], swiftSettings: testSettings),
        // ADServeCoreTests + ADServeDSLTests moved to the standalone ADServe package.
        .testTarget(
            name: "ADServerTests", dependencies: ["ad-server", "ADSearchCascade"],
            swiftSettings: testSettings)
    ]
)

if isDev {
    // Wire the dev-only ADTestKit into the test targets that use it (downstream consumers never see it):
    // the archive fuzz/oracle suites, the renderer's typed-fixture asserts, and the row-codec suite's
    // typed asserts (all to keep heavy chained `#expect`s under the 100ms type-check budget).
    let adTestKit: Target.Dependency = .product(name: "ADTestKit", package: "ADTestKit")
    for name in ["ADArchiveTests", "ADContentTests", "ADStorageTests"] {
        package.targets.first { $0.name == name }?.dependencies.append(adTestKit)
    }
}
