# ADR-0002: Upstream Package Promotions (`Aemi-Studio/*` & `g-cqd/*`)

- **Status:** Accepted — Ready-to-PR branches verified on macOS & Linux
- **Date:** 2026-11-26

## Context

During the Swift 6.4 cross-platform implementation of `apple-docs` on macOS 15.6+ and Linux (Debian 13 arm64), we exercised the `Aemi-Studio/*` and `g-cqd/*` ecosystem end-to-end across SQLite storage, Zstd decompression, hybrid search, JSON-RPC MCP, HTTP serving, SHA-256 verification, HTML/Markdown/DocC parsing, and strict Swift 6.4 quality gates.

## Already Available in Upstream (Adopted Directly)

Audit of `g-cqd/HTTP` (`974a50a`) revealed that several capabilities we initially considered promoting already exist cleanly upstream and are now adopted directly by `apple-docs`:

- `TransportBackbone.recommended` (`.posixKqueue` on Darwin, `.posixEpoll` on Linux) — adopted in `PlatformHTTPServer`.
- `SecurityHeadersMiddleware`, `RequestIDMiddleware`, `RateLimitMiddleware`, `BodyLimitMiddleware`, and `CORSMiddleware` — adopted in `PlatformHTTPServer`.
- Note on `Zstd`: `g-cqd/HTTP` vendors libzstd 1.5.7 as the `HTTPZstd` product (HTTP ADR 0010: symbol-hidden, single-threaded, streaming). `apple-docs` decodes its Zstd blobs through it (`ZstdCodec`, bounded) instead of carrying its own vendored copy, so the process holds one libzstd.

## Implemented & Verified Promotion Branches

### 1. `Aemi-Studio/aemi` — Branch `feat/aemicore-linux-support` (`2888351`)

- **Gap observed:** `AemiCore` failed to build on Linux because `Combine+Publishers.swift` imported `Combine` unconditionally and `Platform.swift` fell through to `UIDevice.current` on non-macOS/watchOS/tvOS targets.
- **Change:** Gated `Combine+Publishers.swift` with `#if canImport(Combine)` and `Platform.swift` with `#elseif canImport(UIKit) ... #else .unknown`.
- **Verification:** `swift build --target AemiCore` passes on Linux (`gcqd-dev` Debian 13 arm64) and all 66 `AemiCoreTests` pass on macOS arm64.

### 2. `g-cqd/AemiSearch` — Branch `feat/hybrid-fusion-and-binary-scorer` (`d407185`)

- **Gap observed:** `apple-docs` built domain-agnostic `BinaryVectorScorer` (MSB-packed binary quantization, Hamming distance, bounded top-K max-heap shortlist, `int8 + f32-scale` dot rescore) and `HybridRankFusion` (score-aware weighted RRF + greedy MMR diversity selection) on top of `AemiSearch`.
- **Change:** Promoted both types plus `HybridRetrievalTests` into `g-cqd/AemiSearch`.
- **Verification:** All 11 tests across 3 suites pass on both macOS arm64 and Linux arm64 (`gcqd-dev`), with zero SwiftLint / `swift-format` findings.

## Next-Stage Upstream Study

- **`g-cqd/HTTP` outbound `HTTPClient` product:** `g-cqd/HTTP` is currently server-focused (`HTTPServer`, `HTTPResponder`, transports, and server middleware). Studying and adding a streaming, redirect-safe, SSRF-hardened `HTTPClient` product to `g-cqd/HTTP` (ETag/conditional GET, bounded response caps, HTTP/2 multiplexing) will let `AppleDocsSources` and `AppleDocsSetup` drop `FoundationNetworking`/`URLSession` completely on Linux.
- **`Aemi-Studio/aemi` `AemiIO` Zstd codec:** Promoting `ZstdCodec` (one-shot + bounded streaming `ZSTD_DStream` decompression) into `AemiIO` (or a dedicated `AemiCompression` product) would unify both `g-cqd/HTTP`'s outbound zstd encoder and `apple-docs`'s section/archive codecs.
