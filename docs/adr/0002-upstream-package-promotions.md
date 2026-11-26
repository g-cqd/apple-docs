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

### 3. `g-cqd/HTTP` — `HTTPZstd` (PR #5)

- **Change:** libzstd 1.5.7 vendored once in `g-cqd/HTTP` (`CHTTPZstd`, symbols hidden) behind `HTTPZstd`;
  `apple-docs` dropped its own `CAppleDocsZstd` decoder and links that one copy (an in-house Swift codec was
  prototyped in `aemi` and abandoned: 0.83–0.99× libzstd speed, levels 1–4 only).

### 4. `g-cqd/HTTP` — outbound `HTTPClient` product (PR #6, `e18e598`)

- **Gap observed:** `AppleDocsSources` crawled through `URLSession`, which on Linux is `FoundationNetworking`
  (libcurl + the system OpenSSL) — a second HTTP and TLS stack in a binary that otherwise links neither.
- **Change:** `g-cqd/HTTP` gained `HTTPClient` (its ADR 0011): a sans-I/O TLS 1.3 client sharing the server
  engine's record layer, key schedule, and swift-certificates chain validation; RFC 9112 request serialization
  and response framing; outbound connects on the kqueue / epoll backbones; per-origin keep-alive pooling,
  deadlines, idempotent retry, filtered redirects, and zstd / gzip / deflate decoding. `apple-docs` replaced
  `URLSessionUpstreamTransport` with `NativeUpstreamTransport` and dropped `FoundationNetworking` from the
  dependency-audit whitelist. Redirects are not followed by the crawler (every fetched URL passes its SSRF
  policy; a `3xx` is surfaced as a status).
- **Verification:** live TLS 1.3 to `developer.apple.com` (RSA) and GitHub (ECDSA) on macOS and Linux; a
  3-framework DocC sync (1,793 pages) in 9.9 s at 53 MiB max RSS, index-gated re-sync unchanged, `--full`
  revalidation answering 66 × `304`; Swift Evolution + TSPL sync 637 pages, 0 errors.

## Next-Stage Upstream Study

- **`g-cqd/HTTP` client follow-ups:** HTTP/2 multiplexing (one connection per origin instead of one per
  in-flight request) and streaming response bodies for large archive downloads.
