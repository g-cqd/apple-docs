# Threat Model & Security Invariants

This document is the living threat model for `apple-docs` (Swift). Every new input surface, archive codec, parser, IPC/HTTP endpoint, or subprocess boundary must add a row below and a corresponding red-first regression test.

## 1. Assets

- Local corpus database (`apple-docs.db`) and extracted resources under `APPLE_DOCS_HOME`.
- Host filesystem outside `APPLE_DOCS_HOME` (integrity against path traversal, symlink escape, and archive slip).
- Operator credentials used during optional authenticated GitHub sync (`GITHUB_TOKEN` / `gh` auth).
- Availability and memory/CPU budgets of public-facing `apple-docs mcp serve` and `apple-docs web serve` deployments.
- Integrity of downloaded snapshots, embedding models, and release binaries.

## 2. Trust Boundaries

| Boundary | Direction | Untrusted Input | Enforcement Layer |
|---|---|---|---|
| CLI arguments & document keys | Inbound | Paths, keys, flags, query strings | `DocumentKey` canonicalizer/validator (`AppleDocsCore`) |
| MCP stdio & Streamable HTTP | Inbound | JSON-RPC payloads, HTTP headers, `Origin`, `X-Request-Id` | `g-cqd/HTTP` body caps, `AemiJSONRPC`, request policy, bounded concurrency semaphore, `AppleDocsOutput` allowlist |
| Web HTTP & `/api/*` | Inbound | URL paths, query parameters, `X-Forwarded-For` | `g-cqd/HTTP`, per-IP LRU rate limiter, strict parameter parsers, CSP/security headers, `AppleDocsOutput` allowlist |
| Snapshot archives (`.tar.zst`, `.tar.gz`) | Inbound | Archive headers, member paths, symlinks/hardlinks, compressed streams | Mandatory `.sha256` verification on remote releases; pre-extract member allowlist + canonical root containment + bounded decompression ratio |
| Upstream crawlers & DocC/HTML/YAML/ONNX | Inbound | Remote JSON, HTML, Markdown, YAML, Protobuf, PDF/SFNT bytes | Non-backtracking `AemiRegex`, iterative tape parsers (`AemiJSON`, `AemiHTML`, `AemiMarkdown`, `AemiProtobuf`), depth/size caps, SSRF/IP pinning on redirects |
| Subprocess execution | Outbound | External tool invocations (`hdiutil`, `pkgutil`, `hb-view`, `rsvg-convert`) | `swift-subprocess` argv arrays (zero shell interpolation), scrubbed environment allowlist, explicit deadlines, stderr byte caps |

## 3. Threat Register

| ID | Threat | CWE / OWASP | Control | Verification |
|---|---|---|---|---|
| T-01 | Path traversal / symlink escape via document key or snapshot member | CWE-22 / CWE-59 | `DocumentKey` rejects `/`, `~`, `\`, NUL/control bytes, empty segments, `.` and `..`, and length > 512 B; filesystem writes verify canonical path containment with `O_NOFOLLOW` | `DocumentKeyTests` (active); archive validator tests (planned with `AppleDocsSetup`) |
| T-02 | Internal metadata / disk path leak across CLI `--json`, MCP, or Web API | CWE-200 | Single public projection layer (`AppleDocsOutput`) with strict Codable allowlists; no internal fields modeled on public DTOs | `PublicDocumentSummary` tests + full leak-guard suites per surface |
| T-03 | Supply-chain tampering on snapshot or model download | CWE-494 | Mandatory SHA-256 verification before archive inspection/extraction; pinned revisions in `Package.resolved` and SHA-pinned GitHub Actions | `workflow-hygiene.yml` (`zizmor`), `AppleDocsSetup` checksum gate tests |
| T-04 | Algorithmic complexity DoS (ReDoS, stack overflow, OOM) on hostile input | CWE-400 / CWE-1333 | Linear-time `AemiRegex`, iterative bounded tape parsers, bounded HTTP body sizes (1 MiB MCP), bounded per-IP LRU rate limiter, heavy-tool semaphore | Boundary/oversized unit tests + libFuzzer targets |
| T-05 | Credential leakage in structured logs or subprocess environments | CWE-532 | Secret redaction on log emission; scrubbed subprocess environment allowlist | Logger redaction & subprocess env tests |
| T-06 | Untrusted browser origin invoking local MCP HTTP server (DNS rebinding / CSRF) | CWE-346 | Default-deny `Origin` header check on MCP HTTP (loopback + explicit allowlist only), JSON-RPC batch rejection, strict `Host` validation | `AppleDocsMCP` HTTP policy tests |
| T-07 | Stored XSS / markup injection through corpus text rendered by the web UI or static export | CWE-79 | Every interpolation escaped (`WebHTMLRenderer.escapeHTML`); Markdown subset rendered by `WebMarkdownBlockRenderer`, which escapes before adding markup; no inline script/style, strict `default-src 'self'` CSP; standalone symbol SVGs served with `default-src 'none'; sandbox` | `WebPagesTests`, `WebServerTests` (hostile `<script>` and `<b>` payloads) |
| T-08 | Destructive or partial static export (replacing an unrelated directory, half-written site) | CWE-73 / CWE-367 | `StaticSiteOutput` refuses non-empty directories without the `.apple-docs-site` marker, writes into a private sibling staging directory, publishes with `renamex_np(RENAME_SWAP)` on Darwin (rename pair elsewhere), fsyncs the parent, validates every relative output path | `StaticSiteBuilderTests` |
| T-09 | Metrics label explosion / information exposure via `/metrics` | CWE-770 / CWE-200 | Route labels collapse to a fixed prefix list or `other`; method/status bounded; endpoint exposed by default only on loopback binds | `WebServingPipelineTests` |
