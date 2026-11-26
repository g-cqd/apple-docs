# ADR-0002: Upstream Package Promotion Candidates (`Aemi-Studio/*` & `g-cqd/*`)

- **Status:** Proposed (Evidence-backed findings from Phases 1–5)
- **Date:** 2026-11-26

## Context

During the Swift 6.4 cross-platform implementation of `apple-docs` on macOS 15.6+ and Linux (Debian 13 arm64), we exercised the `Aemi-Studio/*` and `g-cqd/*` ecosystem end-to-end across SQLite storage, hybrid search, JSON-RPC MCP, HTTP serving, SHA-256 verification, HTML/DocC parsing, and strict Swift 6.4 quality gates.

Several general-purpose gaps emerged that would benefit the whole ecosystem if promoted upstream rather than staying local to `apple-docs`:

## Promotion Candidates

### 1. `g-cqd/HTTP`: Cross-Platform HTTP Client + `TransportBackbone.platformDefault`

- **Observed gap:** `g-cqd/HTTP` provides a zero-NIO HTTP/1.1 + HTTP/2 (+ HTTP/3 on Darwin) **server** (`HTTPServer`, `HTTPResponder`, `POSIXKqueueTransport`, `POSIXEpollTransport`), but has no outbound HTTP client target yet; meanwhile every caller that boots a cross-platform server repeats `#if os(Linux) .posixEpoll #else .posixKqueue #endif` (we already repeated this in `MCPHTTPServer` and `WebHTTPServer`).
- **Recommended promotion:**
  1. Add `TransportBackbone.platformDefault` (resolving to `.posixEpoll` on Linux and `.posixKqueue` on Darwin) directly in `HTTPTransport`.
  2. Study adding a streaming, redirect-safe, SSRF-hardened `HTTPClient` product to `g-cqd/HTTP` (supporting ETag/If-None-Match conditional requests, bounded body caps, HTTP/2 multiplexing, and per-host concurrency limits) so `AppleDocsSources` and `AppleDocsSetup` never need `FoundationNetworking`/`URLSession` on Linux.

### 2. `Aemi-Studio/aemi`: Decouple `AemiCore` from Apple-Only `Combine`

- **Observed gap:** Compiling against `Aemi-Studio/aemi@32f1d61` on Linux fails if any target links `AemiCore` because `AemiCore` unconditionally imports `Combine` (`error: no such module 'Combine'`), even though `AemiKernel`, `AemiDigest`, `AemiIO`, `AemiLexers`, and `AemiRuntime` are cleanly cross-platform.
- **Recommended promotion:** Gate `Combine` extensions in `AemiCore` behind `#if canImport(Combine)` (or extract pure-Swift core types from Combine publishers) so Linux packages can depend on `AemiCore` directly.

### 3. `g-cqd/AemiSearch`: Binary/Int8 Quantized Vector Shortlist + Hybrid RRF/MMR Fusion

- **Observed gap:** `apple-docs` implemented `BinaryVectorScorer` (MSB-packed binary quantization, Hamming distance, bounded top-K max-heap shortlist, `int8 + f32-scale` rescoring) and `HybridRankFusion` (score-aware weighted RRF + greedy MMR diversity selection) alongside `AemiSearch.SearchIndex`.
- **Recommended promotion:** Both `BinaryVectorScorer` and `HybridRankFusion` are domain-agnostic retrieval primitives with zero SQLite or Apple-docs dependencies. Promoting them into `g-cqd/AemiSearch` (alongside its existing BM25/trigram index and binary snapshot codec) would give every `AemiSearch` consumer first-class hybrid lexical+semantic search.

### 4. `g-cqd/HTTP`: `HTTPField.Name` Standard Security Header Constants & Query-String Parser

- **Observed gap:** `apple-docs` implemented a small RFC-safe query-string decoder (`splitTarget`) and security header wrapper (`X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy`) in `WebHTTPResponder`.
- **Recommended promotion:** Promote a zero-allocation `URLQueryItems` / query decoder and a composable `SecurityHeadersMiddleware` into `HTTPServer` / `HTTPMiddleware` inside `g-cqd/HTTP`.

## Next Step

Keep these implementations self-contained and tested in `apple-docs` today; promote them one by one via dedicated PRs to the respective upstream repositories once their APIs stabilize under full corpus sync workloads.
