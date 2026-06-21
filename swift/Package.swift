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

// ADDB_PATH -> the ADDB engine + SQL EXECUTION package. Post-inversion ADDB hosts the executor
// (`ADDBExec`) + the FTS/JSON supersets the `/search` query runs over; the `ADSQLSearch` target
// executes against it (ADSQL is now the engine-free frontend, which `/search` no longer needs).
let addbDependency: Package.Dependency = {
    if let path = Context.environment["ADDB_PATH"], !path.isEmpty {
        return .package(path: path)
    }
    return .package(url: "https://github.com/g-cqd/ADDB.git", branch: "main")
}()

// ADConcurrency (the `ResourcePool` + `TaskProvider`/`Clock` seams) is folded into the ADFoundation
// umbrella package; ad-server takes the `ADConcurrency` product from `package: "ADFoundation"` below,
// and ADServeCore/ADJSON also surface it transitively. Never reaches the zero-external-dep ADCore dylib.

// ADHTML_PATH -> the Foundation-free HTML engine. ADBuilder pulls `ADHTMLCore` for the crawl's HTML
// parser + extractor (the HTMLTape tokenizer → HTMLNode DOM → Markdown/plain-text + HTMLDocument.extract),
// replacing the JS regex `parse-html.js`. Resolves from a local checkout via ADHTML_PATH, else main.
let adhtmlDependency: Package.Dependency = {
    if let path = Context.environment["ADHTML_PATH"], !path.isEmpty {
        return .package(path: path)
    }
    return .package(url: "https://github.com/g-cqd/ADHTML.git", branch: "main")
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

// ADTestKit (the shared testing architecture) is folded into the ADFoundation umbrella package; the
// dev test wiring below references it via `package: "ADFoundation"` (adfoundationDependency).

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
        .executable(name: "ad-cli", targets: ["ADCLI"]),
        // ADSemantic — native semantic candidate retrieval (Stage 1 of the
        // semantic-search tier): the bit-exact port of the JS `semanticCandidates`
        // chunk path. Leaf library over ADStorage + ADEmbed + ADFoundation's
        // ADFCore (Popcount/Endian). Not pulled by the zero-external-dep ADCore
        // dylib — consumed by ad-cli's semantic probe (and, later, the cascade).
        .library(name: "ADSemantic", targets: ["ADSemantic"])
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
        addbDependency,
        adserveDependency,
        adhtmlDependency,
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
        // apple/swift-collections — floored at 1.6.0 to MATCH ADTestKit's requirement
        // (`from: "1.6.0"`) and the committed Package.resolved pin. A lower floor let a
        // transient re-resolution (a sibling momentarily pulling swift-foundation, which
        // caps collections at 1.1.x) silently DOWNGRADE the graph and then break ADTestKit
        // (needs ≥1.6.0) under APPLEDOCS_DEV; the explicit floor turns that into a loud,
        // diagnosable resolution error instead. Used by the server side (ADSearchCascade:
        // OrderedSet for the FTS term builder) + the dev test harness; NOT pulled by ADCore
        // (the dylib stays zero-external-dep).
        .package(url: "https://github.com/apple/swift-collections.git", from: "1.6.0"),
        // apple/swift-algorithms — already resolved transitively (zero new download). Used by
        // ADSearchCascade only (bounded top-K via min(count:sortedBy:)); NOT pulled by ADCore
        // (the dylib stays zero-external-dep).
        .package(url: "https://github.com/apple/swift-algorithms.git", from: "1.2.0"),
        // swift-server/swift-service-lifecycle — already resolved transitively. Used by
        // ADServeCore only (ServiceGroup graceful shutdown); NOT pulled by ADCore
        // (the dylib stays zero-external-dep).
        .package(url: "https://github.com/swift-server/swift-service-lifecycle.git", from: "2.6.0"),
        // swiftlang/swift-markdown (on cmark-gfm) — Apple's CommonMark parser, already
        // trusted by the family (ADHTML uses it). Used by ADBuilder ONLY to parse
        // Markdown SOURCES (Swift Evolution proposals, the Swift book) into the
        // normalized section model — a real parser instead of the retiring JS regex
        // extractor (parse-markdown.js), so normalize is structure-level (cmark skips a
        // `## ` inside a code fence; the JS regex did not). A build-tool dep; NOT pulled
        // by the ADCore dylib.
        .package(url: "https://github.com/swiftlang/swift-markdown.git", from: "0.4.0")
    ] + http3PackageDependencies + adbuildToolsDependencies,
    targets: [
        .target(
            name: "ADBase",
            dependencies: [.product(name: "ADFCore", package: "ADFoundation")],
            swiftSettings: releaseCMO + strictSettings),
        .target(
            name: "ADSearch",
            // ADFCore: `Popcount.hammingDistance` (the shared SWAR bit-distance kernel) for MMR.
            dependencies: [.product(name: "ADFCore", package: "ADFoundation")],
            swiftSettings: releaseCMO + strictSettings),
        .target(name: "ADArchive", swiftSettings: releaseCMO + strictSettings),
        .target(
            name: "ADEmbed",
            dependencies: [
                // ADFUnicode: JS string semantics for the tokenizer. ADFCore: the
                // little-endian f32 read (`Endian.loadLE32`) the int8 rescore dot
                // (`Quantize.dequantDot`) shares with the rest of the AD family.
                .product(name: "ADFUnicode", package: "ADFoundation"),
                .product(name: "ADFCore", package: "ADFoundation")
            ],
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
        .target(
            name: "ADRender",
            dependencies: [
                "ADBase",
                // ADFCore: the shared `XMLEscape` the glyph/symbol SVG builders escape text through.
                .product(name: "ADFCore", package: "ADFoundation")
            ],
            swiftSettings: releaseCMO + strictSettings),
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
            dependencies: [
                "ADBase", "ADArchive", "CSQLiteShim",
                .product(name: "ADJSONCore", package: "ADJSON"),
                // ADFCore: the shared little-endian `appendLE*`/`storeLE*` the row framer emits the
                // §2.5 response wire bytes through (already in the dylib graph via ADCore → ADFCore).
                .product(name: "ADFCore", package: "ADFoundation")
            ],
            swiftSettings: releaseCMO + strictSettings),
        // Search cascade: the byte-exact in-process port of the JS lexical search
        // (fts-query-builder, intent, the tier merge, ranking, projection).
        // SERVER-ONLY — used by ad-server, NOT by the libAppleDocsCore dylib
        // (which stays zero-dep). Max strict concurrency.
        .target(
            name: "ADSearchCascade",
            dependencies: [
                "ADStorage", "ADContent", "ADBase",
                // ADSemantic (Stage-1 candidate retrieval) + ADSearch (the bit-exact
                // Fusion/MMR math) + ADEmbed (the Embedder type the semantic context
                // carries) wire the optional semantic step. Additive: the lexical
                // path (server/MCP, semantic == nil) is unchanged.
                "ADSemantic", "ADSearch", "ADEmbed",
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
                // ADFCore: the audited `PercentCoding.decodeForm` + `UTF8Validation` the query parser
                // decodes/validates `?q=…` through (rejecting malformed/invalid-UTF-8 input).
                .product(name: "ADFCore", package: "ADFoundation"),
                .product(name: "ADConcurrency", package: "ADFoundation"),
                "ADStorage",
                "ADContent",
                "ADRender",
                "ADSearchCascade",
                "ADSQLSearch"
            ],
            path: "Sources/ADServer", swiftSettings: releaseCMO + strictSettings),
        // ADSemantic — native semantic candidate retrieval (Stage 1). Ports the JS
        // `semanticCandidates` chunk path: query embed (ADEmbed) → sign-quantize →
        // Hamming shortlist (ADFCore.Popcount) → int8 rescore (ADFCore.Endian) →
        // max-pool to documents. Leaf over ADStorage + ADEmbed + ADFCore; NOT in
        // the ADCore dylib graph. Max strict concurrency.
        .target(
            name: "ADSemantic",
            dependencies: [
                "ADStorage", "ADEmbed",
                .product(name: "ADFCore", package: "ADFoundation")
            ],
            swiftSettings: releaseCMO + strictSettings),
        // ADWrite — SPIKE foundation for the native crawl WRITER on the ADDB engine
        // (own on-disk format "ADSQLv0"). Proves the write path: open/create a
        // writable ADDB db, run apple-docs `roots`/`pages` DDL, prepared INSERT +
        // bind (text/int/BLOB/NULL) in one transaction (lastInsertRowid), read back
        // via the query API. The full writer (32 apple-docs migrations + crawl
        // persist) will be built on the API this pins. Depends on the ADDB engine
        // products (ADDBExec executor + the ADSQLMigrate framework the full writer
        // will define its schema in) + ADSQL's ADSQLModel (the `Value` type). Same
        // first-party AD* sibling resolution as ADSQLSearch; no new external dep.
        // Consumed by ad-cli's hidden `_addb-write-spike` verb; NOT in the ADCore
        // dylib graph.
        .target(
            name: "ADWrite",
            dependencies: [
                .product(name: "ADDB", package: "ADDB"),
                .product(name: "ADDBExec", package: "ADDB"),
                .product(name: "ADSQLMigrate", package: "ADDB"),
                .product(name: "ADSQLModel", package: "ADSQL"),
                // ADEmbed: the Chunker (anchor + body chunks), Quantize (signCode →
                // vec_bin / i8Code → vec_i8) and Embedder the chunks/vectors writer
                // (IndexEmbeddings) is the native port of src/commands/index-embeddings.js.
                "ADEmbed",
                // ADArchive: ArchiveWriter.writeTarZst (deterministic tar.zst) for the
                // snapshot build (Snapshot, port of src/commands/snapshot.js). Crypto:
                // swift-crypto SHA-256 for the DB/archive checksums + the .sha256 sidecar
                // (the JS Bun.CryptoHasher('sha256')). Both are build-tool deps of the
                // snapshot path only; NOT in the ADCore dylib graph.
                "ADArchive",
                .product(name: "Crypto", package: "swift-crypto")
            ],
            swiftSettings: releaseCMO + strictSettings),
        // ADBuilder — the native crawl + pipeline + web static build (Phase D3). Its
        // FIRST slice is the HTTP CLIENT SEAM the crawler codes against: the
        // `HTTPClient` protocol (modeled on swift-http-types) + the interim
        // `URLSessionHTTPClient` conformer, per rfcs/adserve-http-client-requirements.md.
        // Depends ONLY on swift-http-types + Foundation today, so it builds independently
        // of the churning ADDB/ADServe graph; the heavier deps (ADContent/ADWrite/ADEmbed/
        // ADArchive/ADFIO/ADHTML) are added as the crawler/web pieces land. NOT in the
        // ADCore dylib graph.
        .target(
            name: "ADBuilder",
            dependencies: [
                .product(name: "HTTPTypes", package: "swift-http-types"),
                .product(name: "HTTPTypesFoundation", package: "swift-http-types"),
                // swift-markdown: the CommonMark AST for Markdown-source adapters.
                .product(name: "Markdown", package: "swift-markdown"),
                // ADHTMLCore: the HTML parser + extractor for the HTML-scrape adapters
                // (guidelines / swift-org), replacing the JS regex parse-html.js.
                .product(name: "ADHTMLCore", package: "ADHTML")
            ],
            swiftSettings: releaseCMO + strictSettings),
        // ADBuilderPipeline — the persist boundary. Maps the adapter layer's dependency-free
        // `NormalizedPage` to ADWrite's `NormalizedDoc` and drives `CrawlPersist.persistNormalized`.
        // Kept OUT of ADBuilder deliberately so the adapter + parser layer stays storage-free (the
        // ADWrite/ADDB churn never reaches the adapters — the NormalizedPage DTO is the seam).
        .target(
            name: "ADBuilderPipeline",
            dependencies: ["ADBuilder", "ADWrite", .product(name: "ADDB", package: "ADDB")],
            swiftSettings: releaseCMO + strictSettings),
        // ad-cli — the native read CLI (P7: `frameworks` + `kinds` + `browse` + `read`).
        // Byte-for-byte output-compatible with the Bun cli.js read verbs. Reads via
        // ADStorage; ADContent supplies the String markdown renderer the `read` verb
        // shares with ad-server's read_doc (DocMarkdown.render, the parity-proven
        // path). The `--json` output is projected into ADJSON's `JSONValue` and
        // serialized with `.javaScript(space: 2)` (JSON.stringify byte parity) via the
        // static, Foundation-free `ADJSONCore` (the codec the dylib already links);
        // `OrderedCollections` backs the ordered-object builder. swift-argument-parser
        // is the only external CLI dep. Also hosts the hidden `_semantic-probe` verb
        // (ADSemantic + ADEmbed) used to self-verify Stage-1 semantic retrieval
        // against the JS oracle, and the hidden `_addb-write-spike` verb (ADWrite)
        // proving the native write path.
        .executableTarget(
            name: "ADCLI",
            dependencies: [
                "ADStorage",
                "ADContent",
                "ADSearchCascade",
                "ADSemantic",
                "ADEmbed",
                "ADWrite",
                .product(name: "ADJSONCore", package: "ADJSON"),
                .product(name: "OrderedCollections", package: "swift-collections"),
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
                .product(name: "ADDBExec", package: "ADDB"),
                .product(name: "ADSQLModel", package: "ADSQL"),
                .product(name: "ADSQLFullTextSearch", package: "ADDB"),
                .product(name: "ADSQLJSON", package: "ADDB"),
                // ADFCore: the shared little-endian `appendLE*` the §2.5 response framer emits through.
                .product(name: "ADFCore", package: "ADFoundation")
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
        // ADSQLSearchTests — byte-identity golden for the §2.5 response wire layout (`ResponseFraming`),
        // the gate for the A1 endian consolidation. The server-only `ADSQLSearch` target had no test
        // home; this also seats the future `SearchQuery`-vs-SQLite parity suite (Phase 5A).
        .testTarget(
            name: "ADSQLSearchTests",
            dependencies: [
                "ADSQLSearch",
                // ADDB (Database.open) + ADSQLModel (Value) back the backfill/RowDecoder gates; ADWrite
                // (migrateSchema + CrawlPersist.upsertRoot) backs the denorm-vs-normalized search-equivalence
                // gate, which runs both `searchPagesFramed*` forms over the REAL apple-docs schema on ADDB.
                .product(name: "ADDB", package: "ADDB"),
                .product(name: "ADSQLModel", package: "ADSQL"),
                // ADSQLFullTextSearch — the equivalence gate calls `enableFullTextSearch()` so the
                // `documents_fts MATCH` in both search forms runs (FTS is opt-in, like JSON).
                .product(name: "ADSQLFullTextSearch", package: "ADDB"),
                "ADWrite"
            ],
            swiftSettings: testSettings),
        .testTarget(
            name: "ADSearchCascadeTests", dependencies: ["ADSearchCascade"], swiftSettings: testSettings),
        // ADServeCoreTests + ADServeDSLTests moved to the standalone ADServe package.
        .testTarget(
            name: "ADServerTests", dependencies: ["ad-server", "ADSearchCascade"],
            swiftSettings: testSettings),
        // ADWriteTests — the catalog-parity gate for the native apple-docs schema
        // (ADWrite/AppleDocsSchema). Builds a fresh ADDB catalog via migrateSchema and
        // introspects it through ADDB's public `txn.schema()` (the engine catalog), then
        // shells out to `bun` from the apple-docs root to build the JS-migrated SQLite
        // reference and read its sqlite_master / PRAGMA table_info, and asserts the two
        // catalogs MATCH (tables, columns, indexes, triggers, FTS), normalizing ADDB's
        // strict-typing representation and reporting any differences. Depends on ADWrite
        // (+ the engine façade for the Schema model). No new external dep.
        .testTarget(
            name: "ADWriteTests",
            dependencies: [
                "ADWrite",
                .product(name: "ADDB", package: "ADDB"),
                .product(name: "ADSQLMigrate", package: "ADDB"),
                // ADSQLImport — the "apple-docs swap gate". The persist PARITY gate
                // uses it as the reference bridge: it ingests the JS-writer SQLite
                // into a fresh ADDB DB (DB_ref), so the native persist (DB_native) is
                // compared ADDB-to-ADDB. Additive test-only dep; no new external dep.
                .product(name: "ADSQLImport", package: "ADDB"),
                .product(name: "ADSQLModel", package: "ADSQL")
            ],
            swiftSettings: testSettings),
        // ADBuilderTests — the HTTP-client seam gate: the value types (request/response
        // mapping) + the streamed `ResponseBody` (`collect(upTo:)` size guard) of the
        // interim URLSession client. No live network — the transport behavior is proven
        // by the end-to-end crawl gate later.
        .testTarget(
            name: "ADBuilderTests", dependencies: ["ADBuilder"], swiftSettings: testSettings),
        .testTarget(
            name: "ADBuilderPipelineTests",
            dependencies: [
                "ADBuilderPipeline", "ADBuilder", "ADWrite", .product(name: "ADDB", package: "ADDB"),
                .product(name: "ADSQLModel", package: "ADSQL"),
            ], swiftSettings: testSettings)
    ]
)

if isDev {
    // Wire the dev-only ADTestKit into the test targets that use it (downstream consumers never see it):
    // the archive fuzz/oracle suites, the renderer's typed-fixture asserts, the row-codec suite's typed
    // asserts (all to keep heavy chained `#expect`s under the 100ms type-check budget), and the embed
    // writer gate's deterministic `SeededRNG`-backed fake embedder (IndexEmbeddingsTests).
    let adTestKit: Target.Dependency = .product(name: "ADTestKit", package: "ADFoundation")
    for name in ["ADArchiveTests", "ADContentTests", "ADStorageTests", "ADWriteTests"] {
        package.targets.first { $0.name == name }?.dependencies.append(adTestKit)
    }
}

// AD_ISOLATE=<TestTarget> — reduce the package to ONLY that test target's local
// dependency closure for ISOLATED local verification while sibling packages (ADServe /
// ADDB / ADJSON / …) are edited by other streams and intermittently fail to compile.
// `swift test` otherwise builds EVERY package target (incl. the ad-server executable →
// the churning ADServeCore, and ad-cli/ADCore → ADJSONCore), so a single broken sibling
// anywhere blocks an unrelated gate. Dropping every other target + all products removes
// those graphs from the build. Inert unless the env var is set; CI / normal runs build
// the whole package. (Back-compat: AD_ONLY_ADWRITE_TESTS still selects ADWriteTests.)
let isolationClosures: [String: Set<String>] = [
    "ADWriteTests": ["ADWrite", "ADEmbed", "ADArchive", "ADWriteTests"],
    "ADBuilderTests": ["ADBuilder", "ADBuilderTests"],
    "ADBuilderPipelineTests": [
        "ADBuilder", "ADWrite", "ADEmbed", "ADArchive", "ADBuilderPipeline", "ADBuilderPipelineTests",
    ]
]
let isolateTarget: String? =
    Context.environment["AD_ISOLATE"]
    ?? (Context.environment["AD_ONLY_ADWRITE_TESTS"] != nil ? "ADWriteTests" : nil)
if let isolateTarget, let keep = isolationClosures[isolateTarget] {
    package.targets.removeAll { !keep.contains($0.name) }
    package.products.removeAll()
}
