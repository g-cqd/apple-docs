# ADR-0001: Cross-Platform Swift 6 Architecture, Setup Split & Dependency Policy

- **Status:** Accepted
- **Date:** 2026-11-26

## Context

The existing `apple-docs` implementation on `main` is a ~44.5k LOC Bun/JavaScript codebase with 31 SQLite migrations, 11 upstream source adapters, a CLI, an MCP server (stdio + Streamable HTTP), a local web server and static-site generator, SF Symbols / Apple Fonts pipelines, and an offline `model2vec` semantic search index. A prior attempt to rewrite everything from scratch without relying on existing libraries stalled.

We are starting fresh on an orphan `swift` branch with two explicit product invariants:

1. **Cross-platform runtime and servers:** CLI, MCP server (stdio + Streamable HTTP), web server / static-site builder, storage, search, content rendering, snapshot installation, and upstream crawling must build and run natively on both **macOS 15.6+** and **Linux (x86_64 and arm64)**.
2. **Setup surface split:** Snapshot installation, integrity verification, archive extraction, semantic indexing, and upstream crawling run on both macOS and Linux; macOS-only authoring and extraction tasks (CoreGlyphs SF Symbols catalog/prerendering, CoreText glyph-outline rendering, DMG/pkg extraction via `hdiutil`/`pkgutil`, and local Xcode MobileAsset enrichment) live strictly in a Darwin-gated target.

## Decision

### 1. Target Layering (Enforced by `Scripts/check-layers.py`)

```
                      ┌────────────────┐
                      │   apple-docs   │  (CLI executable)
                      └───────┬────────┘
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌─────────────┐    ┌───────────────┐    ┌─────────────┐
   │AppleDocsMCP │    │AppleDocsComm. │    │AppleDocsWeb │
   └──────┬──────┘    └───────┬───────┘    └──────┬──────┘
          │                   │                   │
          └────────────► AppleDocsOutput ◄────────┘
                              │
    ┌─────────────────────────┼─────────────────────────┐
    ▼                         ▼                         ▼
AppleDocsSetup     AppleDocsPipeline           AppleDocsSearch
    │   ▲                     │                         │
    │   │         ┌───────────┼──────────┐              │
    │   │         ▼           ▼          ▼              │
    │   │  AppleDocsSources  AppleDocsContent           │
    │   │                                               │
    │   └──── AppleDocsSetupDarwin (#if os(macOS))      │
    ▼                                                   ▼
AppleDocsStorage ──► CSQLite                      AppleDocsCore
```

Hard invariants:
- **No upward edges** (`Core` is the leaf; `Storage`/`Content`/`Output` never import `Commands`, `MCP`, or `Web`).
- **Parallel surfaces:** `AppleDocsMCP`, `AppleDocsWeb`, and `apple-docs` (CLI) never depend on each other; all share `AppleDocsCommands` and route every public payload through `AppleDocsOutput`.
- **Darwin isolation:** `AppKit`, `CoreText`, `CoreGraphics`, `ImageIO`, and `SwiftUI` imports are banned outside `AppleDocsSetupDarwin` (`BannedAPITests`). On Linux, `AppleDocsSetupDarwin` compiles cleanly and reports cross-platform capabilities.

### 2. Storage & Search Strategy (Clean v1 + Legacy v31 Importer)

- **Clean Swift v1 SQLite schema** via system `CSQLite` (`libsqlite3`), dropping legacy `pages` table duplication and migrations v1–v31 while maximizing SQLite capabilities (WAL, prepared statement pools, FTS5, external-content trigram index, zstd-compressed raw/section payloads, deterministic `VACUUM INTO` snapshots).
- **Read-only v31 Bun corpus importer** so existing `apple-docs.db` snapshots can be migrated or read seamlessly during transition.
- **Hybrid SQLite + `AemiSearch`:** SQLite owns durable storage, transactions, and FTS5 body search; `AemiSearch` is evaluated and extended where in-memory BM25/trigram/symbol indexing beats SQLite on measured latency and memory footprint.

### 3. Ecosystem Dependencies & Upstream Promotion Policy

All dependencies are restricted to pinned revisions / minor ranges from `Aemi-Studio/*`, `g-cqd/*`, `apple/*`, and `swiftlang/*`:

| Package | Role in `apple-docs` |
|---|---|
| `Aemi-Studio/aemi` | `AemiKernel`, `AemiDigest`, `AemiIO`, `AemiLexers`, `AemiRuntime`, `AemiTestKit` (Linux-safe products; `AemiCore` imports `Combine` and is Apple-only) |
| `g-cqd/HTTP` | Zero-NIO HTTP/1.1 + HTTP/2 (+ HTTP/3 on macOS) server for MCP Streamable HTTP & Web |
| `g-cqd/AemiJSON` | SIMD JSON tape parser/encoder + `AemiJSONRPC` for MCP JSON-RPC 2.0 |
| `g-cqd/AemiSearch` | In-memory BM25 / trigram search index & binary snapshots |
| `g-cqd/AemiHTML` | WHATWG HTML5 parser & HTML-to-Markdown extractors |
| `g-cqd/AemiMarkdown` | Zero-copy CommonMark/GFM parser |
| `g-cqd/AemiRegex` | Linear-time non-backtracking regex engine (zero ReDoS risk) |
| `g-cqd/AemiHMMML` | YAML/TOML/front-matter parsing for docs/config |
| `g-cqd/AemiProtobuf` | Zero-copy protobuf wire decoder for ONNX `model2vec` weight extraction |
| `g-cqd/URLBuilder` | RFC 3986 / WHATWG validated URL construction |
| `apple/swift-argument-parser` | CLI command & flag parsing |
| `swiftlang/swift-subprocess` | Structured, deadline-bounded subprocess execution |

**Upstream promotion rule:** When `apple-docs` identifies a general-purpose gap in the ecosystem—most notably an HTTP client layer in `g-cqd/HTTP` (to replace `FoundationNetworking`/`URLSession` for crawling and downloads), or streaming/quantized/disk-backed search extensions in `g-cqd/AemiSearch`—we evaluate promoting the capability to the upstream package rather than accumulating duplicate primitives inside `apple-docs`.

## Consequences

- Every PR builds and tests on both Linux and macOS via `g-cqd/swift-ci`, with `deadwood`, `dolly`, `arcleak`, `fcheck`, `modeler`, `swift-format`, and strict `SwiftLint`.
- Deployment floor on macOS is **15.6** (matching `g-cqd/HTTP`'s floor), with Swift **6.4.2**.
- `CSQLite` links the OS-provided `libsqlite3` (`libsqlite3-dev` on Ubuntu, SDK `libsqlite3.tbd` on macOS), avoiding Homebrew deployment-target mismatches.
