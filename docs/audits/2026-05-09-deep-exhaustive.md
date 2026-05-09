# Audit 5 — Deep, Exhaustive Audit

**Repo:** `/Users/gc/Developer/ongoing/javascript/apple-docs` @ `d27b946`
**Date:** 2026-05-09
**Scope:** ~28.8k LOC JS (Bun-only), 137 source files, 108 test files. CLI + MCP server (stdio + Streamable HTTP) + local web app for Apple developer documentation.
**Method:** Five parallel deep-audit agents covering Architecture, Security, Performance/Concurrency, Reliability, and SOTA fit. All findings traced to actual source with `file:line` citations.

## 0. Executive Verdict

**Overall posture:** above-average for a single-author 30-KLOC project. Real engineering shows up in places it usually doesn't: WAL+mmap-tuned `bun:sqlite` with read-back diagnostics, opt-in worker-thread reader pool with structured-clone messaging, MCP heavy-tool semaphore + 503 backpressure, precompressed Brotli sidecars, hashed search artifacts with manifest cache-busting, atomic-write + backup pipeline, render-index incremental builds, exemplary `search_docs` MCP tool description, defensive shiki guard against TextMate backtracking. Tooling discipline is strong (Biome, knip, jscpd, Stryker, Bun:test isolate, codecov, dependabot, GH Actions matrix).

### The Big Rocks (if you fix nothing else, fix these)

| # | Issue | Where | Sev |
|---|---|---|---|
| 1 | `storage/database.js` is a 2147-line god module conflating schema, migrations, ~70 prepared stmts, search planning, fuzzy ranking, render-index, fonts, SF symbols, activity log | `src/storage/database.js` | Critical (architecture) |
| 2 | Web dev server binds `0.0.0.0` by default with no auth, no CSP, no per-IP limit, and an on-demand `fetchDocPage` SSRF amplifier | `src/web/serve.js:88-95`, `src/web/routes/docs.route.js:62-79`, `src/web/context.js:122-126` | High (security) |
| 3 | Snapshot install: `tar -xzf` with no symlink jail; SHA-256 verification silently skipped if checksum asset missing; no signature | `src/commands/setup.js:64-159` | High (security/integrity) |
| 4 | No `unhandledRejection` / `uncaughtException` handlers; SIGINT/SIGTERM does not drain in-flight work; launchd hard-kills after 20s | `cli.js:96-99`, `index.js:37-39`, `ops/launchd/*.plist.tpl` | High (reliability) |
| 5 | Pervasive silent `catch{}` swallowing — 49 instances; `searchTrigram`/`searchBody`/`getBodyIndexCount`/snippet enrichment all return defaults on any error | `src/storage/database.js`, `src/commands/search.js` | High (correctness) |
| 6 | Half-finished `pages` → `documents` migration; both tables live; `getPage()` returns polymorphic shapes faking columns | `src/storage/database.js:399-542, 1241-1392` | High (domain modeling) |
| 7 | Sync `gzipSync` blocks the event loop in HTTP response path; render-cache triple-index thrashes on every on-demand doc fetch | `src/web/responses.js:179-228`, `src/web/render-cache.js`, `src/web/routes/docs.route.js:75/102` | High (performance) |
| 8 | MCP HTTP origin policy: when `--allow-origin` is empty, ALL origins are accepted (default config) — any local site can drive the MCP from a browser | `src/mcp/http-server.js:118-152` | High (security) |
| 9 | `PRAGMA foreign_keys = ON` is never set; FKs are decorative | `src/storage/database.js:246-271` | Medium→High (data integrity) |
| 10 | Orphaned commands: `update`, `consolidate`, `snapshot`, `index-rebuild` are fully implemented + tested but never wired to the CLI switch | `cli.js:111-385` vs `src/commands/{update,consolidate,snapshot,index-rebuild}.js` | High (public surface) |

Now the long form, by domain.

---

## 1. Architecture & Code Quality

### 1.1 Layering (the clean parts)

Module graph is acyclic (verified). Most layers are properly decoupled:

- `src/apple/` (DocC parsing) → `lib/` only.
- `src/sources/` (13 source adapters) → `lib/`, `content/`, `apple/`, `pipeline/persist`. Real `SourceAdapter` ABC in `sources/base.js` with `validate*Result` shape checks.
- `src/storage/` → `lib/` only (one dep on `lib/fuzzy.js`).
- `src/search/` (relaxation/intent/ranking) → no DB import at all. Score-in/score-out. **Exemplary.**
- `src/web/routes/` → 11 route modules registered through `route-registry.js`. **Cleanest part of the codebase.**

### 1.2 Boundary Violations & Misplaced Responsibilities

- `src/web/templates.js:1` imports `content/render-html.js`. The HTML "fragment renderer" is not actually source-agnostic content logic — it's the web frontend's article body. Either rename `content/render-html.js` → `content/render-doc-fragment.js` or move under `web/`.
- `src/mcp/server.js:9-13` directly imports `commands/*`, then post-processes through `mcp/projection.js`. The projection step is the implicit "use-case/service" layer that should be explicit and documented.
- `search_docs` MCP tool inlines a `read_doc` follow-up when `args.read=true` (`src/mcp/server.js:99-133`) — two tools' responsibilities in one handler. Retire the flag; clients can chain.

### 1.3 The Three God Modules — Critical

#### `src/storage/database.js` (2147 LOC)

Concrete responsibilities living together:

| Concern | Lines |
|---|---|
| Schema DDL + 13 sequential migrations | 8-204, 279-735 |
| ~70 prepared statements assembly | 820-1226 |
| Domain repository methods | 1228-1700 |
| Four-variant search query planner (FTS, title-exact, trigram, body) | 977-1097, 1444-1474 |
| Fuzzy ranking trampoline | 1542-1556 |
| Render-index repository | 1219-1226, 1800-1816 |
| Activity log + sync checkpoint | 1708-1768 |
| Snapshot meta | 1213-1217, 1743-1753 |
| Fonts repository (asset domain) | 1835-1940 |
| SF symbols repository (asset domain) | 1942-2086 |
| FTS query builder | 2139-2147 |

Decompose into `src/storage/{migrations,repos/{documents,roots,crawl,search,render-index,operations,assets}}.js` behind a `DocsDatabase` facade for backward compat. Direct payoff: reader-pool workers (`src/storage/reader-pool.js:281`) currently re-compile this 2147-LOC module per worker × N workers.

#### `src/web/templates.js` (1566 LOC)

Eight `renderXPage` functions emitting full `<!DOCTYPE html>…</html>` documents via template literals. Specific bugs and duplication:

- **Finding 3.5** — `enrichTopicItems` (`templates.js:1153-1196`) mutates the section array passed in. `web/build.js:339` reuses `sectionsByDoc` across docs; second render of a doc sees previously-enriched JSON with `_resolvedRoleHeading` baked in. Currently dormant (consumed once per doc per build) — defensive clone needed.
- `ROLE_LABELS` map duplicated verbatim at `templates.js:1328-1333` and `:1383-1394`.
- `'symbol' || 'dictionarySymbol' || 'pseudoSymbol' || 'restRequestSymbol'` predicate copy-pasted three times (`:1348, :1420, :1482`).
- 33-line inline `<script>` for 404 URL inference (`templates.js:188-220`) — untested, hand-rolled JS. Extract.
- Three identical inline `<svg viewBox="…">` icons in `buildHeader` (`:642-644`).

Decompose into `src/web/templates/{document-page,framework-page,index-page,search-page,fonts-page,symbols-page,not-found-page,shared}.js`.

#### `src/resources/apple-assets.js` (1499 LOC)

Eight unrelated responsibilities + two large embedded Swift programs as JS template strings:

- `SYMBOL_WORKER_SCRIPT` (line 432), `SYMBOL_PDF_SCRIPT` (986-1072), inline scripts at 814-900 and 1086-1253. All under `// Stryker disable all`.
- `parseXmlPlist` is a real recursive-descent XML parser inlined here (`:682-794`) — belongs in `src/lib/plist.js`.
- Mixes sync orchestration, Swift-shellout rendering, font-format parsing, plist parsing, FS walking, DMG mounting.

Decompose into `src/resources/{swift/*.swift, swift-runner.js, fonts/{sync,sfnt,render}.js, symbols/{sync,render}.js}` + `src/lib/plist.js`.

### 1.4 Other Large Files

- `content/normalize.js` (964) and `content/render-html.js` (918) — split per-section-kind. Note `markdownToHtml` is hand-rolled inside `render-html.js`; the `RENDER_SKIPLIST` in `web/build.js:34-49` documents an infinite-loop bug on lines like `### ` (empty heading). No regression test exists.
- `web/build.js` (896) — single 480-line `buildStaticSite` function does directory setup, asset bundling, per-framework rendering, search artifacts, sitemaps, atomic swap, and worker fan-out. Split into `web/build/{index,assets,static-pages,document-pages,framework-pages,checkpoint,atomic-swap,worker-fanout}.js`.
- `content/parse-html.js` (732) — two personalities: HTML→text/markdown converter + DocC metadata extractor.

### 1.5 Domain Modeling Defects

- **Half-finished `pages` → `documents` migration.** `upsertPage()` writes to both tables (`database.js:1273-1301`); `getPage()` (line 1378-1393) returns either a `documents`-shaped row with synthesized `path`/`framework`/`abstract`/`declaration`/`platforms` and faked `downloaded_at: null`, or a `pages`-shaped row — callers can't tell which. `refs` and `document_relationships` coexist with one-time backfill. Kill `pages` and `refs` in migration v14. Add `documents.status/etag/last_modified/downloaded_at`, rename `documents.key` → `path`.
- **`source_metadata` JSON blob** = primitive obsession at the column level. WWDC year/track filtering is a JS-side post-filter on a 1000-row cap (`commands/search.js:455-473, :65`), silently truncating large WWDC searches. Per-source extension tables (`wwdc_session_meta`) joined when `source_type='wwdc'` would index these.
- **Four-way kind taxonomy** (`role`, `role_heading`, `kind`, `doc_kind`). `matchesKindFilter` (`commands/search.js:403`) heuristically splits "looksLikeDisplayedKind" by case to pick which column to match. Pick one canonical `kind`.
- **Min-version columns leak DocC assumptions** onto every source. Five always-NULLable `min_ios`/`min_macos`/... columns spread across 10 search predicate copies. Replace with a `platforms` JSON or a `document_platforms` extension table.
- **Asset domains are bolted on.** `apple_font_files`, `sf_symbol_renders` share no joins with the doc graph. `sf_symbols.bundle_path` is a filesystem path in the DB — machine-local state should never have been persistent. Extract to `AssetsDatabase` (sibling .db) or JSON catalogs.

### 1.6 Code Smells (selected)

- **49 silent `try/catch {}` blocks** swallow errors and return defaults. Worst offenders: `database.js:1457-1459`, `:1465-1467`, `:1521-1522`, `:1539-1540` (search variants → `[]`); `commands/search.js:111-120`, `:308-311`; `web/templates.js:843, 871, 979` (`parsePlatformsJson` → null); `mcp/cache.js:147, 168` (stamp errors). Introduce `lib/safe-call.js` with `safeCall(fn, { default, log, label })`.
- **Source-type string literals** proliferate across 6+ files (`'apple-docc'|'hig'|'guidelines'|'apple-archive'|'packages'|'sample-code'|'swift-book'|'swift-evolution'|'swift-org'|'wwdc'`). Centralize in `src/sources/types.js`.
- **22 sites of `value.contentText ?? value.content_text`** / `section.sectionKind ?? section.section_kind` — symptom of `coerceSection` being optional. Canonicalize at the row boundary; coerce once.
- **2 custom error classes in 28k LOC** (`BackpressureError`, `PaginationItemTooLargeError`). Most thrown errors are `new Error(string)`. `pipeline/discover.js:110-113` parses error messages by string-prefix to classify (`isUpstreamMiss = message.startsWith('Not found:') || message.startsWith('HTTP 403')`). Type these.
- **Long parameter lists:** `searchPages(ftsQuery, rawQuery, { framework, kind, limit, language, sourceType, minIos, minMacos, minWatchos, minTvos, minVisionos })` — 11 args, recurs at `:1449, :1454, :1462`.
- **Magic numbers** scattered across 14 files: `cache_size=-64000`, `chunkSize=900` (SQLite param limit awareness undocumented), `RENDERER_VERSIONS` baked in (`apple-assets.js:457-481` `renderer: 6` invalidator).

### 1.7 Public Surface

- **Two binaries doing the same thing.** `apple-docs` (`cli.js` routes `mcp start` → `mcp/server.js`) vs `apple-docs-mcp` (`index.js` boots `mcp/server.js` directly). `index.js` reads `APPLE_DOCS_LOG_LEVEL`, `cli.js` does not. Drift hazard.
- **Orphaned commands (Critical hygiene):** `update.js` (273 LOC), `consolidate.js` (451), `snapshot.js` (248), `index-rebuild.js` (124). All have JSDoc + tests but `cli.js:111-385` switch never cases them. ~1500 LOC of "wired to nothing" that knip doesn't flag because setup consumes `snapshotBuild` transitively. **Decision required: wire or retire.**
- **MCP tool surface (8 tools)** is internally consistent and well-described. `search_docs` description (`mcp/server.js:61`) is exemplary — explicitly tells the LLM how to use the tool, warns about natural-language phrasing.

### 1.8 Testing Architecture

- 105+ test files. `bun test --isolate` per-file process isolation. Per-adapter coverage 1:1 (gap: `apple-archive.test.js`).
- Coverage threshold 75%; baseline 80.30% functions / 78.48% lines.
- **Coverage gaps:** `web/route-registry.js`, `web/build.js` worker fan-out + greedy-bin-packing partitioning, `markdownToHtml` infinite-loop regression test, per-migration round-trip-from-v0 tests (only one such exists at `database.test.js:175`).
- **No `fast-check`/property-based tests** despite ideal targets (HTML parser, FTS query builder, `safeFilename`, `tokenize`, ranking).
- **No Playwright/Puppeteer e2e** — the entire Web UI (search worker, symbol gallery, font preview) has zero browser-level verification.
- **No network-failure fixtures** in `fetchWithRetry` tests (no ECONNRESET, mid-body abort, ENOTFOUND, 429+Retry-After, malformed JSON).
- **No concurrent-write race tests** (e.g. two `persistFetchedDocPage` for same path; two `tx()` blocks contending).

### 1.9 Tooling

- `tsconfig.json` exists with `checkJs: false`, `strict: false` → `tsc --noEmit` runs but validates nothing. Either flip `checkJs: true` (537 JSDoc annotations would start meaning something) or drop the file. `devDependencies.typescript: ^6.0.2` is a forward pin (current stable: 5.x).
- `dist/` checked into git (`dist/smoke/{symbols,home,fonts}.png`) despite `.gitignore` containing `dist/`.
- `biome.json` has formatter disabled — defensible only if formatting is enforced elsewhere. Add a hook.
- No `prepublishOnly` — a dirty branch `bun publish` ships unaudited code.

---

## 2. Security

Adopt an attacker mindset throughout. Findings ranked by exploitability.

### 2.1 Path Traversal & Arbitrary FS Write — High Latent Risk

- **`keyPath` does not constrain output to `dataDir`** (`src/lib/safe-path.js:76-81`). `safeFilename` only sanitizes the leaf basename; `..` segments in the key path resolve cleanly outside `dataDir`. All current callers happen to pre-validate via the docs-route regex (`/^[a-z][a-z0-9_-]*(\/[a-z0-9_-]+)*$/i`), so unreachable today — one careless caller from arbitrary write. Add `path.resolve(result).startsWith(path.resolve(dataDir))` invariant inside `keyPath`.
- **`tar -xzf` on the snapshot has no symlink jail** (`src/commands/setup.js:151-159`). Modern tar refuses absolute paths and `..` entries but does not block symlink-based escape during extraction (entry creates symlink → subsequent entry writes through it). Compromised release archive plants `manifest.json` → `~/.ssh/authorized_keys` and writes through it. Pass `--no-overwrite-dir --no-same-owner --no-same-permissions`; pre-validate entries via `tar -tzf` and reject any that escape after canonicalization.
- **Predictable `/tmp` symlink races.** PID-only temp script paths in `src/resources/apple-assets.js:902, 953` (`apple-docs-symbol-pdf-${process.pid}.swift`) — on a shared host, predictable PID + symlink plant = arbitrary file clobber under the apple-docs user. `Bun.write` follows symlinks. Also `apple-assets.js:586` (`${filePath}.${process.pid}.tmp`), `pipeline/persist.js:197` (`.bak-${pid}-${random}` — random present), `lib/atomic-write.js:5` (random present, OK). Wrap each spawn in `mkdtempSync`-derived directory.
- **Asset routes only block substring `..` markers** (`src/web/routes/assets.route.js:42-43, 86-87`). Bun's URL parsing pre-decodes one pass; double-encoded `%252e%252e` would slip past this check pre-decode, but the actual matched form is post-decode. Acceptable today; defensively add `path.resolve` containment.
- **`Bun.spawn(['tar', ...])` for snapshot build** (`commands/snapshot.js:130-154`) is build-side, low risk.

### 2.2 SSRF & Outbound URL Handling — Medium→High Under Default Web Config

- **Web `docsHandler` triggers outbound `fetchDocPage` per request, no per-IP rate limit.** Anyone reachable on `0.0.0.0:3000` can drive Apple-side traffic via a path matching the regex. Per-host bucket is 5/s burst 2 (single shared bucket for Apple). Combined with default LAN bind (§2.4), a hostile peer:
  1. Pins the Apple-host bucket, blocking legitimate fetches.
  2. Uses the server as a confused deputy to enumerate Apple's documentation backend (404 vs 200 timing).
- **`APPLE_DOCS_API_BASE` env-var pivots all Apple fetches** (`src/apple/api.js:6`). Container/CI env injection redirects every outbound call.
- **`fetch` follows redirects, no private-IP block** (`src/lib/fetch-with-retry.js:74`, `commands/setup.js:77, 106`). A 302 to `http://169.254.169.254/...` silently follows. For setup, the body is tar-extracted — attacker controls install. Pin redirect target to `*.githubusercontent.com`/`*.objects.githubusercontent.com`.
- **`fetchHtmlPage` has no host allow-list at the boundary** (`src/sources/swift-org.js:109`, `apple-archive.js:198`, `guidelines.js:24`). Sources self-curate; future caller could pass any URL.
- **`per-host-rate-limiter.buckets` Map is unbounded** (`src/lib/per-host-rate-limiter.js:24`). Crawl across many hosts grows for the process lifetime. Add LRU cap (256).

### 2.3 Injection — Mostly Clean

- **SQL:** pure parameter binding throughout. Three string-interpolation sites: `VACUUM INTO '${...}'` (`commands/snapshot.js:67`, internal path only — but SQLite has no bind for `VACUUM INTO`; flag if attacker-control reaches it); placeholders for `IN (...)` (values still bound); migration `ALTER TABLE` DDL (constants only).
- **FTS5: limited bypass.** `buildFtsQuery` at `commands/search.js:537-559` forwards raw user query when it contains `AND/OR/NOT/"`. The query is bound (`MATCH $query`), so no SQL injection — but FTS5 mini-language permits `column:` filters and `NEAR()`. Hostile client can DoS a query (parser throws, swallowed at `database.js:1457-1459`) or query unintended columns. Mirror `buildResourceFtsQuery` (`database.js:2139-2147`) and quote-escape unconditionally.
- **HTML rendering:** consistently escaped. `escapeHtml`/`escapeAttr` in `templates.js:526-533` and `render-html.js:911-918`. `isSafeHref` (`render-html.js:903-909`) blocks dangerous schemes. Markdown `[text](url)` (`render-html.js:806-847`) escapes before the regex rebuild. JSON-LD `escapeJsonLd` correct.
- **Client-side JS:** local `esc()` helpers in 5 asset files don't escape `'`. All attribute interpolations use double quotes, so currently safe; defensive practice would include `'` escape in `web/assets/{search,search-page}.js:34-40, :24`.
- **Markdown `<doc:Name>` references** (`render-html.js:806-814`): `displayName = page.replace(/-/g, ' ')`, concatenated then `escapeHtml`'d on the whole string. Safe.
- **YAML:** no deserializer (`lib/yaml.js` is serialize-only).
- **Shell:** argv arrays everywhere, `git-auth.js:51-58` runs git with sanitized env (`PATH HOME USER LOGNAME SHELL` + `GIT_TERMINAL_PROMPT=0`).
- **Stdin smuggling:** SF Symbol worker name has no `\n` guard (`apple-assets.js:331`: `proc.stdin.write(${name}\n)`). Reject `\r\n\0` in name.
- **Prototype pollution:** none reachable. Argv parser writes on object literal; `__proto__` becomes own property under `JSON.parse`.

### 2.4 HTTP/MCP Server Hardening

- **High — Web server binds `0.0.0.0` by default.** `src/web/serve.js:88-95` passes no hostname. `Bun.serve` binds all interfaces. Hotel-Wi-Fi exposure of corpus + SSRF amplifier. MCP HTTP correctly binds `127.0.0.1` (`src/mcp/http-server.js:66`). Default `hostname: '127.0.0.1'`; require explicit `--host`.
- **High — No CSP.** `src/web/context.js:122-126` ships `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`. Inline 404 script blocks any `script-src 'self'` policy without hash-pinning. Refactor or hash the inline blocks.
- **Medium — MCP origin policy "allow all" by default.** `src/mcp/http-server.js:118-123`: when `allowedOrigins.length === 0`, every Origin is accepted. CORS preflight reflects the origin. `Content-Type: application/json` requires preflight, so a browser visit to `evil.com` while the user runs `mcp serve` locally results in JS exfiltration of corpus or driving outbound fetches. Default to `['http://localhost', 'http://127.0.0.1']`; refuse cross-origin POSTs without an explicit flag.
- **Medium — No request body size limit on either HTTP server.** `Bun.serve` default is 128 MiB. Trivial DoS: post 128 MiB JSON to `/mcp` repeatedly. Set `maxRequestBodySize: 1_000_000`.
- **Medium — No per-IP rate limiting on either server.** MCP semaphore (8 active × 64 queue) prevents CPU starvation, not single-peer monopoly.
- **Low — No `idleTimeout` config**, slowloris-class concerns minimal on localhost.
- **Low — Stack traces logged in error responses** (`mcp/http-server.js:281`) leak absolute paths.

### 2.5 Auth, Secrets, Integrity

- **Token handling is solid.** `git-auth.js` env-allowlists, sidecar config written `0o600` with explicit `chmod`, never logged, never embedded in URLs. One minor: sidecar tmp = `${path}.${pid}.tmp` is non-random.
- **High — Snapshot integrity = SHA-256 fetched from same release.** No GPG/cosign/minisign signature. And if the `.sha256` asset is missing, integrity verification is silently skipped (`commands/setup.js:104-119`: `if (checksumAsset) { ... }`). Make checksum mandatory; add cosign signing.
- **DMG/PKG path:** `extractDmgFonts` runs `hdiutil attach -readonly -nobrowse`. DMG source `fileName` is treated as a basename — if a DMG carries `../../etc/foo` as a filename, `copyFile` could escape. Apple's curated DMGs make this low-likelihood; add `path.basename` defensively.
- **Logger has no redaction layer** (`src/lib/logger.js:6-11`). A future careless `logger.info('fetching', { headers })` flushes a token. Add an explicit `redact()` for sensitive keys.

### 2.6 Crypto / Hashing

- `Bun.CryptoHasher` for SHA-256 — fine. No constant-time compares needed (no token comparison surface in this app).
- ETag comparisons use `===` (not secrets, fine).

### 2.7 DoS / Resource Exhaustion

- **`searchCache` LRU max 512 with no entry-byte cap** (`src/web/context.js:74`). 512 × hundreds-of-KB = potentially gigabytes. Add byte cap or store IDs only.
- `bundleCache` is a Map, not LRU (`web/context.js:145`). Bounded by `ENTRY_BUNDLES + STANDALONE_ASSETS` count, OK.
- **No per-route handler timeout.** Pathological FTS query pins a worker. MCP heavy-tool semaphore caps to 8; web has no equivalent.

### 2.8 Web Client JS

- All `innerHTML` interpolations pass through local `esc()` (`tree-view.js:67-74, 119-362`; `search.js:34-141`; `search-page.js:209-219`; `symbols-page.js:300`; `collection-filters.js:116-461`).
- No `eval`, no `new Function`, no `document.write`.
- Local `esc()` in `search.js`/`search-page.js` doesn't escape `'` — defensive gap, not exploitable today.

### 2.9 Dependencies

Production deps are minimal: `@modelcontextprotocol/sdk: ^1.29.0`, `shiki: ^4.0.2`. `^` ranges + transitive trust depend on `bun.lock`. **No OSV scanner, no Trivy, no Snyk, no `bun audit` in CI.** No SBOM, no SLSA provenance, no `npm publish --provenance`.

---

## 3. Performance & Concurrency

### 3.1 Database / Storage — Solid Foundation, Two Real Cliffs

`bun:sqlite` with thoughtfully-tuned PRAGMAs (`mmap_size=10GB` with read-back diagnostic, `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64MB`, `wal_autocheckpoint=2000`). FTS5 (porter unicode61) + trigram FTS5 + body FTS5 with maintained triggers. Migrations atomic.

**Real performance issues:**

- **High — Render-cache global invalidation thrash.** `routes/docs.route.js:75/102` calls `invalidateDocumentCaches()` on every on-demand doc fetch (cold path). That wipes `web/render-cache.js`'s triple-index (`knownKeys` + `ancestorTitleIndex` + `roleHeadingIndex`, ~100-200MB on full corpus) and `searchCache` and `cachedTitleIndex`. One user landing on a never-fetched page invalidates everyone's caches. Replace with per-key invalidation or stamp-based check.
- **High — `_trigramCache` per process and per reader-worker.** `lib/fuzzy.js:46-56` builds a Map of (trigram → `{id, title}`) entries; ~7M entries × 12 workers = 600-1200 MB worst case. Stale until process restart after `apple-docs update`. Move into SQLite as `(trigram, doc_id)` rows or stamp it with `corpusStamp`.
- **Medium — `documents_fts` and `documents_trigram` are NOT external-content tables.** Migration 6 creates them WITHOUT `content='documents'`, so they store their own copy of the title/abstract/etc. Switching to external-content halves FTS storage and trigger work on every doc upsert. One-time migration.
- `getAllTitlesForFuzzy()` is full-scan (`database.js:1542-1556`). Cached module-level, only invalidated when db pointer changes; long-lived MCP HTTP processes hold stale caches indefinitely.
- **Two queries do the work of one in search:** `searchTitleExact` (`database.js:1013`) duplicates tier-0 logic already baked into `_searchDocuments`. Schema-13 added `idx_documents_title_nocase`; collapse the call sites.
- **Per-result JSON.parse of platforms** in `formatResult` (`commands/search.js:335`) — same row may be parsed 3× across tier dedup. Parse once.
- `getDocumentSnippetData` does a follow-up `SELECT` for documents already returned by `searchPages`. Include `id` in the search SELECT, drop the round-trip.

### 3.2 Reader Pool — Well-Engineered

- Fail-and-respawn semantics (`pickSlot` linear-scan O(N) for N≤12, fine).
- Recycle on db pointer change.
- `await slot.ready` correctly serializes dispatch on a freshly-spawned worker.
- **Issue: structured-clone tax on every result.** Search-result arrays of rich objects with `platforms_json` strings cross thread boundary. At concurrency=16 × 200-row windows ≈ 3 MB/sec cloning. **Recommendation:** ship JSON strings (cheaper than structured clone for plain shapes), or move ranking inside the worker so only top-N (limit=50) crosses back.
- **Issue: no idle reaping.** Each worker holds a SQLite handle + 10 GB virtual mmap × N workers. Add idle timeout for long-lived MCP HTTP servers.

### 3.3 Caching

- `lib/lru.js`: naive Map-based, no TTL, no byte accounting. `mcp/cache.js` has its own LRU with TTL + corpus-stamp invalidation refreshed via `statSync` every 5s — `statSync` on every cache miss after the window adds a syscall per request at high RPS. Use `fs.watch` instead.
- **Cache-key SHA-256** in `mcp/cache.js` is overkill for `read-doc { path: "swiftui/view" }` — short string concat suffices.
- `web/asset-bundler.js`: in-flight Promise dedup is correct (recent commit `95db66d` verified). `bundleCache` is bounded by entry-list, OK.

### 3.4 Concurrency Primitives

- **Semaphore** (`lib/semaphore.js`): FIFO via `_queue.shift()` (O(N) per release), but `acquire()` fast-paths when `active < max`, violating strict FIFO. **No AbortSignal/timeout:** a wedged shiki call holds a permit forever; `mcp/http-server.js:230` waits indefinitely. Add cancellation.
- **Pool** (`lib/pool.js`): synchronous `drain()` allocates all concurrency Promises eagerly; spreads `[...items]` cloning the input array (346K items → extra alloc); errors array uncapped (run with 346K failures retains every Error).
- **Rate-limiter uses `Date.now()`** (`lib/rate-limiter.js:24-27`). Clock-jump-backward gives weird math; clock-jump-forward gives a free burst. Switch to `performance.now()`.
- **Per-host limiter has no eviction** — sequenced before primary, so one slow host holds a primary slot.
- **`fetchWithRetry`:** exponential + jitter ✓, honors `Retry-After` (seconds only — HTTP-date format silently parses to NaN). No retry budget: 500 in-flight × 3 retries × global outage = 1500 useless attempts. **No AbortSignal threaded through** — crawler shutdown can't propagate.

### 3.5 HTTP Server — Gzip is the Bottleneck

- **High — Synchronous `gzipSync` in `responses.js:179-228`** blocks the event loop for the full compress duration (~10-50 ms for 1 MB). Single largest TTFB risk. Fixes: precompress at build time + let Caddy serve `.gz`/`.br` directly (already partially done for assets >16 KB); or use `CompressionStream`; or run compression in a worker thread.
- **No streaming.** `finalizeResponse` always `await response.text()` / `arrayBuffer()` — for 1 MB rendered pages that's a single allocation but no streaming TTFB.
- `Bun.serve` defaults: no per-conn limits, no keepalive tuning. Acceptable for a CDN-fronted deploy.
- **`createServer` runs per request in MCP HTTP** (`http-server.js:209`), building 13 zod tool schemas (~1-5ms each). Pool the `McpServer` instances or build the tool table once.

### 3.6 Search Worker (Browser)

- `buildIndices` builds prefix index lengths 2-6 on the client. ~10M Set inserts × 5 prefix lengths = ~50M operations on the client thread. 1-3s on a fast laptop, 10+s on a phone. Memory: hundreds of MB on memory-constrained clients. **Cap prefix at 4; ship precomputed inverted index from build.**

### 3.7 Hot Paths

- **`cli.js` startup eagerly loads every formatter and command + opens DB before dispatch.** Even `apple-docs --help` opens the DB. Lazy-import per-command in the switch (already done for mcp/web/setup).
- **`_prepareStatements` builds ~70 statements unconditionally on every DB open.** Lazy-init via Proxy getter or split hot/cold groups. Reader workers each rebuild every statement (× 12 workers).
- **Search inner-loop spreads `{ ...filterOpts, framework: fw }`** per framework × per relaxation tier (`commands/search.js:65-188`), then re-clones across worker boundary. Build filter object once per query.
- **`buildFtsQuery` regexes compiled per call.** Hoist to module scope.

### 3.8 CPU-Bound Stages

- **shiki defended thoughtfully:** `HIGHLIGHT_MAX_BYTES=8KB` guard against TextMate backtracking (documented `swift-evolution/0253-callable` case pinned a thread for hours), `APPLE_DOCS_NO_HIGHLIGHT` kill switch, content-hashed LRU 1000.
- **`parse-html.js` regex parser is full-string, not streaming.** 100s of KB Apple-archive HTML → several copies allocated. Blocks event loop in single-thread render.
- **`symbol-pdf-to-svg.js` is fully synchronous.** Decode via `inflateSync`. `bytesToLatin1` doubles peak memory (string + buffer). 10-50 ms blocking per symbol render. Move to worker thread.

### 3.9 I/O Patterns

- `atomic-write.js` does NOT `fsync` the staged temp file or the directory after rename. Power-loss between write and rename leaves stale temp. For doc/markdown writes (regenerable), acceptable.
- `existsSync` on every persist (`pipeline/persist.js:202, 211, 223`) — 6+ syncs per call × 500 in-flight = 3000 syncs/sec. Replace with try/catch on rename.
- macOS default `ulimit 256` vs `APPLE_DOCS_CONCURRENCY=500`. Document the requirement.

### 3.10 Top 10 Perf Wins (prioritized)

1. Stop globally invalidating web caches on every on-demand doc fetch.
2. Replace render-cache triple-index with on-demand prepared `SELECT`s.
3. Replace synchronous gzip with precompressed assets / streaming compression.
4. Move `_trigramCache` into SQLite or stamp it with `corpusStamp`.
5. Switch `documents_fts`/`documents_trigram` to `content='documents'` external-content.
6. Use `performance.now()` in rate-limiter.
7. Lazy-import command modules in `cli.js`.
8. Add AbortSignal/timeout to `Semaphore.acquire()`.
9. Move `symbol-pdf-to-svg` onto a worker thread.
10. Trim search-worker prefix index (cap at 4, lazy-build).

### 3.11 Scalability Ceilings (estimated)

| Dimension | Soft | Hard | Bottleneck |
|---|---|---|---|
| Corpus (docs) | ~500K | ~2M | trigram cache, render-cache, client prefix index |
| Web RPS cached | ~5K/s | ~10K/s | event-loop gzip |
| Web RPS uncached search | ~150-300/s | ~500/s | search cascade + structured clone |
| MCP concurrency | 8×64 (configurable) | OS limits | by-design backpressure |
| Memory (long-lived MCP HTTP) | ~600 MB | ~2 GB | trigram × N workers, render-cache |

---

## 4. Reliability & Robustness

### 4.1 Process Lifecycle — High

- **No `unhandledRejection` / `uncaughtException` handlers** in `cli.js`, `index.js`, `mcp/http-server.js`, `web/serve.js`. Bun's default dump on crash. Combined with launchd `KeepAlive: true` (which only restarts on crash, not exit-code 0), a self-exit during shutdown is treated as intentional and the daemon stays down.
- **SIGINT/SIGTERM does not drain in-flight work** (`cli.js:96-99`, `index.js:37-39`). Crawler in-flight fetches dropped, DB writes mid-batch lost, reader-pool workers killed without flush. Combined with launchd's default 20s `ExitTimeOut`, every restart hard-kills active requests.
- Build worker children don't honor parent SIGTERM (signal handler missing in worker entrypoint).

**Fixes:** install `unhandledRejection`/`uncaughtException` handlers (log + graceful exit). Replace synchronous cleanup with bounded async drain (30s cap). Set launchd `ExitTimeOut: 30` and `KeepAlive: { SuccessfulExit: false }`.

### 4.2 Retries & Backoff

- **`fetchWithRetry`:** retryable set `[408, 429, 500, 502, 503, 504]`. Honors `Retry-After`. Issues: retries on `JSON.parse` failure (likely permanent); retries on `ENOTFOUND`/`ECONNREFUSED` (also permanent). Classify error → only retry network/timeout. Surface parse/DNS as terminal.
- **No circuit breaker.** 500 RPS into a 5xx storm = 1500 retry attempts.
- **GitHub API secondary rate limit** (`403 + Retry-After` and `403 + X-RateLimit-Remaining=0`) not handled.

### 4.3 Atomicity & Idempotency

- `lib/atomic-write.js`: write-temp + rename. Random suffix present. **No fsync of temp or dir.** Cross-device EXDEV not handled in `web/build.js:507` (only in `lib/atomic-write.js`).
- Concurrent `persistFetchedDocPage` for the same path can race the backup-restore. Add per-key promise-lock.
- DB writes use `BEGIN IMMEDIATE`. `db.tx()` rejects async callbacks (`database.js:754-767`) but only after the sync portion runs. Any side effects from sync tail of an async fn already happened.
- Migrations atomic in single `BEGIN/COMMIT` ✓. But 5+ `try { ALTER TABLE ... } catch {}` silently swallow real schema errors.
- `update.js` immediately tombstones a page on a single 404. Require N consecutive 404s.

### 4.4 Data Integrity

- **`PRAGMA foreign_keys = ON` is never set.** All FK declarations are decorative. Documents can reference vanished pages. Add the PRAGMA + integrity-check on next migration; fix orphans.
- 16-hex hash for render-index `html_hash`, 12-hex/48-bit for filename collisions. Adequate at current corpus scale; watch as corpus grows.
- Snapshot/restore not idempotent across hosts (timestamps + machine-local paths in some metadata).
- `freezeJsonValue` (`safe-json.js:24-36`) recurses unbounded. `markdownToHtml` recurses without stack-overflow guard.

### 4.5 Cancellation & Resource Leaks

- **No AbortController/AbortSignal propagation** through pool, Semaphore, fetchWithRetry, or any HTTP handler. Client disconnect doesn't cancel work upstream.
- `bundleCache` in-flight dedup OK; other places lack it. `/api/search` cache is not single-flight — adopt the same Promise-cache pattern.
- File handles, timers, event listeners — not surveyed exhaustively but no obvious leaks beyond the documented GET-SSE leak in stateless MCP (`http-server.js:217-218`).
- No orphaned-temp cleanup at startup. Crashes leave temps; they accumulate.

### 4.6 Observability — Thin

- `lib/logger.js`: JSON to stderr, levels OK. No correlation IDs, no `child(fields)` API, no log sampling, no severity-to-syslog mapping.
- `/healthz` on web is liveness-only. `health.route.js` returns `{ ok: true }` unconditionally. Watchdog (`watchdog.sh:104-105`) checks only that string. **A wedged DB returns healthy.** Add `/readyz` that touches DB + verifies reader-pool has alive workers.
- **No metrics endpoint, no Prometheus, no OTEL, no Sentry.** Cache stats internal; only surfaced via opt-in healthz. Counters in `mcp/cache.js` are exactly the metrics ops needs — just need Prometheus exposure.
- No crash diagnostics, no last-N-log buffer.

### 4.7 Edge Cases

- macOS APFS Unicode-normalization-insensitivity + bytewise-UTF-8-truncating `safeFilename` → snapshots built on Linux ext4 restored to APFS could collapse paths.
- Windows path 260-char limit not enforced (out of scope today).
- O(n²) HTML cleanup loops in `wwdc.js`, `parse-html.js` SVG strip — small inputs today, exploitable on a malicious source.

### 4.8 Deployment Ops

- launchd plists (`apple-docs.{web,mcp,proxy,watchdog}.plist.tpl`):
  - No `SoftResourceLimits`/`HardResourceLimits` for memory.
  - No `ExitTimeOut` (default 20s, hard-kills inflight).
  - `KeepAlive: true` doesn't restart on exit-code 0.
- watchdog: cooldown 300s; RSS limits 3GB web / 8GB MCP — 3GB tight with 10GB SQLite mmap counted. Expect false positives.
- No log rotation (`${OPS_DIR}/logs/*.log` grows unboundedly).
- No build-time validation that `.br` precompressed sidecars decompress to identical bytes.

### 4.9 Top 10 Reliability Gaps (prioritized)

1. Install `unhandledRejection`/`uncaughtException` handlers.
2. Implement graceful-drain SIGINT/SIGTERM + launchd `ExitTimeOut: 30`.
3. Crawler circuit breaker / host-aware backoff on 5xx storm.
4. Honor GitHub secondary rate-limit (`403 + Retry-After`).
5. Enable `PRAGMA foreign_keys = ON`.
6. Per-key promise-lock around `persistFetchedDocPage`.
7. Classify retryable vs terminal in `fetchWithRetry`; add max-body-size guard.
8. Require N consecutive 404s in `update.js` before tombstoning.
9. Single-flight `/api/search` cache.
10. Correlation IDs through MCP HTTP and web routes.

---

## 5. State of the Art & Ecosystem Fit

### 5.1 What the Project Does Better Than Typical

1. **MCP tool descriptions are exemplary** — `search_docs` description tells the LLM exactly how to use the tool, warns against natural-language phrasing, documents relaxation tier semantics.
2. **`bun:sqlite` is genuinely tuned** — `mmap_size=10GB` with read-back diagnostic, FTS5 + trigram FTS5 + body FTS5, `wal_autocheckpoint=2000` matched to corpus size.
3. **Defensive shiki integration** — `HIGHLIGHT_MAX_BYTES`, `APPLE_DOCS_NO_HIGHLIGHT` kill switch, content-hashed LRU. Comments explain the why.
4. **Pragmatic, opt-in reader-thread pool with structured rollout** — `APPLE_DOCS_MCP_READERS=on`, fall-through to main-thread, `classifyRpcPayload` heavy/light + 503 backpressure.
5. **Snapshot/distribution architecture** — three tiers (lite/standard/full), `VACUUM INTO` for hot-DB copy, manifest with schema+counts+checksums, cron-driven CI snapshot, `bun build --compile` cross-platform binaries, hashed search artifacts with manifest cache-busting.

### 5.2 SOTA Gaps by Domain

**MCP server** — uses SDK 1.29 with the web-standard streamable-HTTP transport (ahead of the older Express-based one). But:
- No `outputSchema` on tools (SDK 1.29 supports it; `structuredContent` is already populated manually). 50 lines of zod for huge LLM-affordance gain.
- No tool annotations (`readOnlyHint`, `idempotentHint`, etc.).
- No prompts. None registered. A docs server is a natural prompt host.
- No auth (deliberately, behind `cloudflared`) — fine for current model.
- No SSE/streaming for `search_docs` body indexing (deliberately stateless: comment at `:69-73` explains rmcp/Codex client confusion).
- No cancellation propagation.

**Search** — custom database + 11-rule reranker. **Completely lacks embeddings/semantic search.** For an LLM-targeted MCP server, this is the single biggest SOTA gap. ~150 MB MiniLM-L6 index over titles+abstracts in `sqlite-vec` or flat float32 = massive lift on natural-language queries. FTS5 `bm25()` with explicit weights would replace some of the bespoke rerank.

**HTML/Markdown** — bespoke regex-based parser (`parse-html.js`, 732 LOC). Pragmatic for known DocC inputs, but vulnerable to: nested `<pre>`, CDATA, conditional comments, malformed self-closing, character refs outside the hand-rolled list. The unified ecosystem (`rehype-parse + rehype-raw + mdast/remark/micromark`) is the SOTA.

**Web UI** — `templates.js` is pure string-template SSR. Zero runtime, fast — but every interpolation requires manual `escapeHtml`/`escapeAttr`, so a 1566-line file is huge audit surface. `lit-html` SSR or Eta would auto-escape with the same zero-runtime profile.

**Asset bundler** — `Bun.build` properly used (target: browser, minify, IIFE per-entry). Missing: code splitting (incompatible with IIFE), source maps in dev, PWA manifest, service worker for offline. Brotli precompressed sidecars + Caddy precompressed mode = modern. No HTTP/3 in `Caddyfile.tpl`.

**Search worker** — raw `postMessage`/`addEventListener`, no Comlink. Fine for single-purpose. Sequence-id cancellation correct.

**Testing** — Bun:test + Stryker mutation (with documented Bun runner workaround in `stryker.config.mjs:7-13`). MCP contract test uses official SDK in-memory transport — SOTA. Gaps: no `fast-check` property tests; no Playwright/Puppeteer e2e; no network-failure fixtures.

**Type safety** — JSDoc + `tsc --noEmit` with `checkJs: false` = doesn't actually validate. Either flip `checkJs: true` (start with `database.js`, `mcp/server.js`, `web/context.js`) or drop the file.

**Tooling** — Biome, knip, jscpd, Stryker, dependabot all wired. Missing: OSV scanner / Trivy / `bun audit` in CI; biome formatter disabled; no `lint-staged`/pre-commit; no release-please/changesets; no `prepublishOnly`.

**Packaging** — `bun build --compile` produces signed-checksum binaries for macOS/Linux. Missing: Windows binary, homebrew formula, code signing/notarization (macOS Gatekeeper hits), Sigstore/cosign provenance, SBOM, `npm publish --provenance`.

**Observability** — structured JSON logs + healthz only. No OpenTelemetry, no Prometheus `/metrics`, no Sentry. Semaphore stats and cache stats already collected — just not exposed. Easy OTLP win.

**AI/docs surface** — `llms.txt` and `robots.txt` (with Content-Signal) are forward-looking and well-written. MCP tool descriptions are SOTA. Only gap: no embeddings index.

**Security posture** — Dependabot ✓; permissions tight in workflows ✓; no `eval`/`new Function`; safe-path + safe-json modules; security headers minus CSP. Missing: SLSA provenance, SBOM, OSV scanner, CSP, SRI on bundles.

### 5.3 Five Highest-Value Modernizations

1. Embedding index over titles+abstracts (MiniLM-L6, `sqlite-vec` or flat float32) + hybrid lexical+semantic `search_docs`.
2. `outputSchema` and tool annotations on all 11 MCP tools.
3. `checkJs: true` + per-file `// @ts-check` rolling out from `storage/database.js`, `mcp/server.js`, `web/context.js`.
4. OpenTelemetry + Prometheus `/metrics` exporting the existing semaphore/cache stats.
5. SLSA provenance + signed binaries + `npm publish --provenance` (cosign + release-please flow).

---

## 6. Cross-Cutting Consolidated Priorities

These are findings flagged by multiple audits — fix once, gain in many dimensions.

| Theme | Lifts |
|---|---|
| Decompose `storage/database.js` | Architecture (Critical), Performance (per-worker compile cost), Reliability (test isolation per repo), Maintenance |
| Wire/retire orphaned commands | Architecture, Public surface, Maintenance (~1500 LOC) |
| Stop global cache invalidation on docs fetch | Performance (High), UX |
| Default web hostname: `'127.0.0.1'` | Security (High), Reliability (less attack surface) |
| Mandatory checksum + cosign signing for snapshots | Security (High), Reliability (supply chain) |
| Tar symlink jail | Security (High), Data integrity |
| `unhandledRejection`/`uncaughtException` + graceful drain | Reliability (High), Observability |
| Type errors + replace silent `catch{}` with logged `safeCall` | Reliability, Code quality, Observability |
| Embedding index + `outputSchema` | SOTA (highest LLM affordance), Search quality |
| Async/precompressed compression + ditch `gzipSync` | Performance (High), TTFB |
| `PRAGMA foreign_keys = ON` | Data integrity, Reliability |
| AbortSignal end-to-end through Semaphore/Pool/fetch/handlers | Performance, Reliability, Cancellation |
| Central `src/config.js` for env vars | Code quality, Tooling, Documentation |
| OpenTelemetry / Prometheus export of existing counters | Observability, Reliability, SOTA |

---

## 7. Verdict & Roadmap

### One-paragraph Summary

apple-docs is the work of a careful single author who clearly understood the domain, the runtime, and the operational tradeoffs. The structural problems are concentrated in three god modules and one half-finished schema migration; the security exposure is concentrated in three places (default LAN bind, snapshot supply chain, MCP origin policy); the reliability exposure is concentrated in one place (process lifecycle); the performance ceiling is gated by two cliffs (gzip on the response path, render-cache + trigram-cache global thrash). Fix those concentrations and this codebase moves from "runs reliably on a quiet day" to "production-grade for a multi-tenant LLM-facing MCP service." The biggest LLM-affordance lift on top of that is an embedding index.

### Suggested Rollout Order

**Phase 1 (1-2 days, highest blast radius):**
- Wire/retire orphaned commands; document MCP/web public surfaces.
- Default web bind to `127.0.0.1`; require explicit `--host`.
- Make snapshot checksum mandatory; add `--no-overwrite-dir` etc. to tar.
- Install `unhandledRejection`/`uncaughtException` handlers; raise launchd `ExitTimeOut`, `KeepAlive: { SuccessfulExit: false }`.
- Enable `PRAGMA foreign_keys = ON`; one-shot orphan check.
- Default MCP `allowedOrigins` to localhost variants.

**Phase 2 (1 week):**
- Decompose `storage/database.js` into `repos/`.
- Replace global `invalidateDocumentCaches` with per-key.
- Replace `gzipSync` in response path with precompressed assets + edge compression.
- Add AbortSignal to Semaphore/Pool/fetch.
- Centralize env config; document all knobs.
- Replace silent `catch{}` with logged `safeCall`.

**Phase 3 (2 weeks):**
- Decompose `web/templates.js` and `resources/apple-assets.js`.
- Kill `pages` + `refs` (migration v14).
- Migrate `documents_fts`/`documents_trigram` to `content='documents'`.
- Move `_trigramCache` into SQLite.
- Land `outputSchema` + tool annotations on every MCP tool.
- Wire OTEL/Prometheus to the existing counters.
- Property-based tests for parsers + ranking.

**Phase 4 (a sprint):**
- Embedding index + hybrid `search_docs`.
- `checkJs: true` rollout.
- SLSA provenance + cosign for releases.
- Playwright e2e for the web UI.

This is genuinely high-quality JS infrastructure. The findings above aren't "this is bad" — they're "this is the next octave."
