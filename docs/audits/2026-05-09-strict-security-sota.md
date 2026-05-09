# Audit 3 — Strict Security & SOTA-Baseline Audit

**Date:** 2026-05-09
**Scope:** read-only review of `/Users/gc/Developer/ongoing/javascript/apple-docs`. No tracked source edits were made; jscpd generated ignored `reports/` artifacts during audit.

**Local checks:**
- `bun run typecheck` passed
- `bun run lint` passed
- `bun test --isolate` passed (1347 tests)
- `bun run lint:unused` passed
- `bun run lint:duplication` found 33 clones / 361 duplicated lines
- `bun audit` found 9 transitive vulnerabilities

**SOTA baseline used:**
- MCP transport security — https://modelcontextprotocol.io/docs/concepts/transports
- OWASP CSP Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
- OWASP Logging Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- SLSA levels — https://slsa.dev/spec/v1.0/levels

## Critical Findings

### 1. MCP HTTP transport is origin-open by default, conflicting with current MCP security guidance

`src/mcp/http-server.js:118` accepts missing origins, and `src/mcp/http-server.js:121` accepts every browser Origin when `allowedOrigins` is empty. CORS then reflects the caller at `src/mcp/http-server.js:134`. The docs also state no built-in auth at `README.md:203` and `docs/self-hosting.md:80`.

**Impact:** browser-origin attacks and DNS rebinding against local or LAN MCP servers can invoke tools/data access if a client exposes HTTP MCP.

**Fix:** reject browser Origin by default, require explicit exact origins, keep native/no-origin clients separate, and require auth/token/mTLS for non-loopback deployments.

### 2. MCP buffers full POST bodies before size checks or heavy-call gating

`src/mcp/http-server.js:193` calls `await request.text()` without a byte cap. The concurrency semaphore is applied only after classification, so a large malformed body consumes memory before protection.

**Impact:** unauthenticated memory DoS on `/mcp`.

**Fix:** enforce `Content-Length` and streaming body caps before buffering, reject chunked bodies above a small budget, and count malformed JSON requests against the same backpressure path.

### 3. Snapshot install path is supply-chain fragile: checksum is optional and tar extraction is not path-safe

Checksum verification only happens if a checksum asset exists at `src/commands/setup.js:103`, and extraction shells out to `tar -xzf` at `src/commands/setup.js:151` without validating archive members. Existing data is deleted before extraction at `src/commands/setup.js:145`.

**Impact:** compromised release assets can overwrite arbitrary user-writable paths or leave installs broken.

**Fix:** require checksums/signatures, validate tar members for absolute paths, `..`, symlinks, hardlinks, and extract to a temp dir before atomic swap.

### 4. Corpus key path construction allows traversal if an adapter ever emits hostile keys

`src/lib/safe-path.js:76` splits key and joins segments verbatim. Intermediate segments are explicitly trusted by comment, but external adapters and on-demand fetch paths feed this storage layer.

**Impact:** malicious or malformed source keys can escape `raw-json` / `markdown` roots.

**Fix:** central `validateStorageKey`, reject empty/`./`/`../`/absolute segments and encoded separators, then `resolve()` plus root-prefix guard.

## High Findings

### 5. Unauthenticated render endpoints create CPU, memory, and persistent disk amplification

Font text rendering accepts arbitrary text at `src/web/routes/fonts.route.js:104`, then `renderFontText` does not cap text length at `src/resources/apple-assets.js:521`. SF Symbol renders include attacker-controlled size/color/cache dimensions at `src/resources/apple-assets.js:457` and persist files at `src/resources/apple-assets.js:503`.

**Impact:** public endpoints can spawn Swift repeatedly and grow cache storage indefinitely.

**Fix:** cap text length, restrict sizes/colors, add render concurrency/rate limits, LRU/TTL/quota render caches, and process timeouts.

### 6. Swift renderer temp script names are deterministic and race-prone

Script paths use `process.pid` only at `src/resources/apple-assets.js:902`, `src/resources/apple-assets.js:953`, and `src/resources/apple-assets.js:1256`.

**Impact:** concurrent renders can overwrite/delete each other's scripts, causing flaky output or request failures.

**Fix:** `mkdtemp`/random per invocation, or a precompiled helper binary.

### 7. On-demand docs route can be abused as a network/write amplification path

Missing docs trigger live Apple fetch and persistence at `src/web/routes/docs.route.js:61`. The rate limiter queues without a max at `src/lib/rate-limiter.js:16`.

**Impact:** public users can create unbounded pending work, outbound requests, and database writes.

**Fix:** route-level client rate limits, bounded limiter queues, negative-cache misses, and make on-demand fetch opt-in/admin-only for public deployments.

### 8. Downloaded DB/resource snapshots can cause arbitrary local file disclosure through font file paths

The font API serves `font.file_path` directly from DB at `src/web/routes/fonts.route.js:31`, and ZIP generation reads every DB-provided path at `src/web/routes/fonts.route.js:72`.

**Impact:** a malicious/corrupt snapshot DB could point font rows at sensitive local files and expose them via HTTP.

**Fix:** store relative paths only, resolve under approved resource roots, and refuse paths outside those roots.

### 9. Dependency audit currently fails

`bun audit` reports 9 advisories through `@modelcontextprotocol/sdk` and dev tooling chains, including `fast-uri`, `ip-address`, and `hono`.

**Impact:** some are HTTP/server-adjacent transitive packages.

**Fix:** upgrade `@modelcontextprotocol/sdk`, `@stryker-mutator/core`, and lockfile; rerun audit in CI as a blocking check.

## Medium Findings

### 10. Version filtering is lexicographic in SQL and can silently drop valid results

Version columns are compared as text at `src/storage/database.js:1005`, `src/storage/database.js:1034`, `src/storage/database.js:1062`, and `src/storage/database.js:1090`.

**Impact:** `9.0 <= 10.0` sorts incorrectly as strings, so search availability filters are unreliable.

**Fix:** store normalized numeric version parts or remove SQL prefilter and apply numeric JS filtering after overfetch.

### 11. MCP search_docs.limit and browse.limit are unbounded

Search limit has no max at `src/mcp/server.js:74`, and command search accepts arbitrary windows at `src/commands/search.js:31`. Browse defaults to all pages at `src/mcp/server.js:225`, then loads all framework pages at `src/commands/browse.js:36`.

**Impact:** large MCP responses and memory pressure.

**Fix:** hard max limits, pagination-first MCP responses, and DB-level limiting.

### 12. Reader worker pool has unbounded pending requests

`src/storage/reader-pool.js:170` adds every call to a worker pending map with no max, timeout, or cancellation.

**Impact:** slow queries or worker stalls accumulate memory under load.

**Fix:** max pending per worker/global, request deadlines, cancellation propagation, and overload errors.

### 13. Web response finalization buffers and synchronously gzips whole bodies

Hashable responses are fully read at `src/web/responses.js:187`, and dynamic gzip buffers the full body plus `gzipSync` at `src/web/responses.js:214`.

**Impact:** event-loop blocking and memory spikes on large docs/search/render output.

**Fix:** size thresholds, streaming compression, and skip gzip for oversized dynamic responses.

### 14. App-layer web security headers are incomplete

Runtime headers only include nosniff, DENY, and referrer policy at `src/web/context.js:122`.

**Impact:** weaker defense-in-depth for externally sourced rendered docs.

**Fix:** ship CSP, Permissions-Policy, COOP/CORP, and tests for headers; do not rely solely on edge config.

### 15. GitHub Actions supply chain is below SLSA-style expectations

Actions are tag-pinned, not SHA-pinned: `.github/workflows/ci.yml:20`, `.github/workflows/ci.yml:42`, `.github/actions/setup/action.yml:7`, and `.github/workflows/release-binaries.yml:45`.

**Impact:** tag movement or compromised actions can affect release artifacts.

**Fix:** pin to SHAs, enable artifact attestations/provenance, add CodeQL/Scorecard, and verify provenance in setup.

### 16. Ops scripts source `.env` as shell in privileged flows

`ops/lib/env.sh:13` sources `ops/.env`, and `ops/bin/install-daemons.sh:14` uses it during installer execution.

**Impact:** command substitutions in `.env` execute as whoever runs the installer, potentially root.

**Fix:** parse dotenv as data, validate file ownership/mode, and avoid shell evaluation.

### 17. Native process execution lacks consistent deadlines

Swift renderers at `src/resources/apple-assets.js:905`, `src/resources/apple-assets.js:956`, and `src/resources/apple-assets.js:1259`, plus tar paths, do not enforce process timeouts.

**Impact:** hung native tools can tie up requests or jobs indefinitely.

**Fix:** shared spawn helper with timeout, kill, stdout/stderr byte caps, and metrics.

## Low / Correctness Findings

### 18. `storage gc --older-than` appears broken

It deletes `activity.timestamp` at `src/commands/storage.js:112`, but schema defines `started_at` at `src/storage/database.js:97`. Tests missed this path.

### 19. `snapshotBuild --tag` can escape output naming

`tag` is accepted at `src/commands/snapshot.js:47` and interpolated into archive/checksum/manifest paths at `src/commands/snapshot.js:127`, `src/commands/snapshot.js:173`, and `src/commands/snapshot.js:177`.

**Fix:** strict tag regex.

### 20. Font ZIP endpoint builds whole archives in memory

`src/web/routes/fonts.route.js:70` reads every file into memory and `src/web/routes/fonts.route.js:79` builds one buffer.

**Fix:** prebuild/cache ZIPs or stream with limits.

### 21. Content-Disposition filename sanitization is incomplete

Single font downloads strip only quotes at `src/web/routes/fonts.route.js:38`, and family ZIP names use `familyId` directly at `src/web/routes/fonts.route.js:88`.

**Fix:** strict filename sanitizer or RFC 5987 encoding.

### 22. Type checking is not strong enough for a JS-heavy codebase

`tsconfig.json` has `allowJs` but `checkJs: false` and `strict: false` at `tsconfig.json:6`.

**Impact:** `bun run typecheck` passing does not prove much about core JS.

**Fix:** enable `// @ts-check` incrementally or migrate high-risk modules to TypeScript with strict.

### 23. Default crawl profile is operationally aggressive

README documents 500 in-flight fetches and 500 req/sec at `README.md:48`, matching CLI defaults at `cli.js:84`.

**Impact:** poor third-party friendliness and self-inflicted instability on constrained networks.

**Fix:** lower defaults and require explicit `--aggressive`.

### 24. No obvious project security disclosure process or security scanning workflow

I did not find `SECURITY.md`, CodeQL, or Scorecard. For a public MCP/web server with release artifacts, that is below current open-source baseline.

## Architecture / SOTA Delta

The project has solid bones: static-first web serving, SQLite-backed corpus, good test volume, structured JSON logging, parameterized SQL in the reviewed query paths, and useful CI quality gates. The weak spots are not ordinary style issues; they are boundary-control issues.

Compared with current production expectations, the main gaps are: default-deny browser origins for MCP, bounded request bodies and queues everywhere, authenticated public MCP, signed/provenanced release snapshots, app-layer security headers, process deadlines, and explicit resource budgets for render/search/fetch workloads.

**Priority fix order:** MCP origin/body/auth first; snapshot/tar/path validation second; render/cache/process limits third; unbounded queues and result limits fourth; supply-chain hardening fifth; then correctness/type-safety cleanup.
