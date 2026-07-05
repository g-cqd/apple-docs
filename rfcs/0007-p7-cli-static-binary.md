# RFC 0007 — P7: CLI + single static binary, Bun retired

- **Status**: Planned — **groundwork underway (2026-07-05)**. Prerequisites have
  advanced past authoring: storage is native (the ADDB corpus is built via
  `ad-cli import` — SQLite→ADDB in ~5 min — and **PROMOTED**, so `bun:sqlite` can no
  longer open the live `apple-docs.db`; the old SQLite is kept as `.sqlite.bak`), and
  `ad-cli` / `ad-server` serve the full read + serve + ops surface native-by-default.
  **Oracle-migration groundwork landed** (the §6 step-1 prerequisite): the `swift/Tests`
  suite is a confirmed **standalone** gate (621 green, 0 failures, covers every Bucket-A
  parity domain), `SchemaParityTests` was reference-flipped off live `bun`/`src` onto a
  committed fixture, and 5 redundant JS-side FFI-parity tests were retired (RFC 0001 §10).
  Still gated on: the native web **static build** (kept shelling to `bun build` + a shiki
  coprocess as BUILD-only tools, operator decision), the `cli.js` sync/build pipeline, and
  the entry-point flip. Sequenced behind P6 / [RFC 0005](0005-server-framework.md) +
  [RFC 0006](0006-codebase-health.md). **First end-to-end JS↔Swift parity audit ran
  2026-07-05** (§11): found + fixed one corpus-breaking regression (`roots.page_count`),
  characterized the remaining gaps, and produced a two-tier harness design (§12) —
  making the §9 "verb-for-verb golden parity" / "JS↔Swift corpus parity" gates concrete
  for the first time instead of just declared.
- **Audience**: maintainers. Like every RFC here this is repo documentation,
  not product documentation — not built or indexed by the docs site.
- **Carries**: phase **P7** of the [RFC 0001](0001-swift-native-transition.md)
  ladder — the last one.

## 1. Why

P7 is the endgame of the Swift-native transition: replace the Bun/JavaScript
**runtime and entrypoint** with a single statically-linked Swift binary per
platform, and delete `package.json`'s runtime dependencies. Every hot/heavy
module (`fusion`, `archive`, `embed`, `content`, `render`) is already
native-by-default with a bit-identical JS fallback; P5 shipped the native
storage foundation; P6 / RFC 0005 port the servers and the MCP protocol. What
remains after those land is **the CLI dispatcher and packaging** — the last
things tying the project to Bun.

The win is operational, not performance: one downloadable binary, no Node/Bun
install, no `node_modules`, a smaller supply-chain surface, and the retirement
of the entire TypeScript quality-gate apparatus (which exists only to keep the
JS honest).

## 2. Scope

**In scope**
- Port `cli.js` (the 397-LOC dispatcher) to a `swift-argument-parser` CLI that
  mirrors every verb 1:1 over the existing native targets.
- Port the ops surface: launchd (macOS) + systemd (Linux) unit templating and
  the on-disk file layout the CLI writes.
- Produce one **statically-linked** binary per platform (musl on Linux, native
  on macOS) — distinct from the bridge-era `libAppleDocsCore` dylib.
- Sunset Bun: after one overlap release, remove `package.json` runtime deps and
  retire the TS gates (Workstream B) alongside the deleted JS.

**Out of scope (explicitly)**
- No feature changes. P7 is an entrypoint/packaging swap; the CLI surface, MCP
  tool contracts, web routes, snapshot archives, and DB schema stay byte- and
  contract-compatible (RFC 0001 §1 non-goals).
- The server runtime itself (P6 / RFC 0005) and the storage bridge-flip (P5)
  are prerequisites, not P7 work.
- Windows packaging stays P8 (deferred, RFC 0001).

## 3. CLI port — verb-for-verb

`cli.js` dispatches these verbs; each maps to an already-native target. The
Swift CLI is a thin `AsyncParsableCommand` tree over `ADServer` / `ADCore` /
`ADStorage` / `ADSearchCascade` — no new logic, just argument parsing +
invocation.

| `cli.js` verb | Swift subcommand | Backing target |
| --- | --- | --- |
| `search [--read]` | `search` | ADSearchCascade (+ semantic tier) |
| `read` | `read` | ADStorage + ADContent (lookup → markdown) |
| `frameworks` / `browse` / `kinds` | `frameworks` / `browse` / `kinds` | ADStorage projections |
| `sync` | `sync` | ADServer sync pipeline + source adapters |
| `setup` | `setup` | snapshot fetch/extract/index |
| `status` | `status` | ADStorage freshness + crawl state |
| `mcp start` / `mcp serve` | `mcp start` / `mcp serve` | RFC 0005 native MCP (stdio / Streamable HTTP) |
| `mcp install` | `mcp install` | client-config writer |
| `web build` / `web serve` / `web deploy` | `web …` | RFC 0005 server + static build |
| `storage` / `snapshot` / `consolidate` / `index` / `prune` / `version` | same | ADStorage maintenance (`MAINTENANCE_COMMANDS`) |

**Parity mechanism**: each verb keeps a per-command `APPLE_DOCS_NATIVE` kill
switch during overlap, and a **verb-for-verb golden parity harness** diffs the
Swift CLI's stdout/exit-code against `cli.js` on a fixed corpus + arg matrix —
the same gate discipline used for every prior phase. JSON output is compared
intrinsically (deep-equal parsed) via ADJSON, human output byte-for-byte.

## 4. Ops ports

- **launchd** (macOS) + **systemd** (Linux) unit templating: the CLI emits the
  service unit for `mcp serve` / `web serve`, replacing the current Bun-invoked
  units. Templates are generated, not hand-edited, so the binary path + flags
  stay in sync with the CLI surface.
- **File layout**: `$APPLE_DOCS_HOME` (default `~/.apple-docs`) — `apple-docs.db`,
  `resources/models`, `resources/symbols`, `cache/`, snapshot install metadata —
  is unchanged; the Swift CLI reads/writes the identical paths so an existing
  install keeps working across the cutover.

## 5. Single static binary

- **Linux**: static-musl build (`swift build --static-swift-stdlib`, musl SDK),
  with the system C libraries (`sqlite3`, `zstd`, `harfbuzz`/`freetype`) linked
  in — no glibc, no `node_modules`, runs on a bare container.
- **macOS**: native build; system libs come from the OS.
- This is a **standalone executable**, distinct from the bridge-era dylib that
  Bun `dlopen`'d. The dylib + FFI exports can be deleted once Bun is gone (the
  fallbacks they backed are deleted with the JS).
- Distribution: one artifact per `(os, arch)` published from the existing CI
  build/test matrix; the snapshot archive format is unchanged.

## 6. Bun sunset

After a one-release overlap where both entrypoints ship and the parity gate is
green on `main`:

1. Delete the JS implementations whose Swift equivalents are live (the
   `APPLE_DOCS_NATIVE` fallbacks become dead code).
2. Remove `package.json` **runtime** deps:
   - `@modelcontextprotocol/sdk` — killed by the RFC 0005 native MCP protocol.
   - `shiki` — syntax highlighting; needs a Swift replacement or an accepted
     degradation (see §7). **Blocker to full removal — tracked as a decision.**
3. Replace the Bun-only build steps: `Bun.serve` (→ SwiftNIO, P6), `bun:sqlite`
   (→ ADStorage, P5), the `Worker` reader pool (→ native actors, P5), and
   `Bun.build` for browser-asset bundling (→ a build-time bundler that doesn't
   require Bun at runtime; see §7).
4. Retire the TS quality gates (biome, tsc/checkJs, knip, jscpd, file-size,
   coverage) and the `bun test` suites as their JS is deleted — they exist only
   to keep the JS honest and have no role once it's gone.

## 7. Decisions / open questions

- **D-0007-1 · Syntax highlighting (`shiki`)**: the static HTML build and the
  web server highlight code blocks via shiki (TextMate grammars in JS). Options:
  (a) a Swift highlighter (e.g. tree-sitter grammars via a vetted C lib),
  (b) precompute highlighted HTML at snapshot-build time and ship it, or
  (c) accept plain `<pre><code>` and drop highlighting. Must be settled before
  `shiki` can leave `dependencies`. **Open.**
- **D-0007-2 · Browser-asset bundling**: `Bun.build` currently bundles
  `src/web/assets/**` into entry bundles at build time. P7 needs a
  Bun-independent build step (a vendored bundler invocation, or precompiled
  assets shipped in the snapshot). Runtime must not depend on Bun. **Open.**
- **D-0007-3 · Overlap window length**: how many releases ship both entrypoints
  before the JS is deleted. Default: one green-on-`main` release. **Open.**

## 8. Phases (each independently committable + gated)

1. **P7.1 — CLI skeleton**: `swift-argument-parser` command tree, all verbs
   parsing + wired to native targets behind `APPLE_DOCS_NATIVE`; golden parity
   harness stands up (read-only verbs first: `search`, `read`, `frameworks`,
   `browse`, `kinds`, `status`, `version`).
2. **P7.2 — write/maintenance verbs**: `sync`, `setup`, `storage`, `snapshot`,
   `consolidate`, `index`, `prune` — gated against `cli.js` on a scratch corpus.
3. **P7.3 — server verbs**: `mcp` + `web` delegate to the RFC 0005 runtime
   (prerequisite); parity on protocol contracts + route responses.
4. **P7.4 — static packaging**: musl-static Linux + macOS artifacts in CI;
   ops-unit templating; install/upgrade smoke tests on a clean host.
5. **P7.5 — Bun sunset**: resolve D-0007-1/2, delete JS + runtime deps + TS
   gates after the overlap release.

## 9. Gates

- **Verb-for-verb golden parity** vs `cli.js` (per-verb `APPLE_DOCS_NATIVE`
  switch): human output byte-identical, JSON intrinsically identical (ADJSON).
- **Snapshot determinism** (double-build + sha256) and **JS↔Swift corpus
  parity** stay green — P7 changes the entrypoint, never the data.
- **Static binary smoke**: the musl artifact runs every verb on a bare
  container; the macOS artifact on a clean machine.
- **Supply chain**: post-sunset, `package.json` has no runtime `dependencies`;
  Swift deps stay within the RFC 0001 §2 allow-list (`swift-argument-parser` is
  already sanctioned under `apple/*`).

## 10. Sequencing / prerequisites

P7 is **last**. It cannot start its server verbs until:
- **P5** storage bridge-flip is GO (today: foundation shipped, token-gated off;
  the `bun:sqlite` / `Worker` kills are explicitly P7-coupled).
- **P6 / RFC 0005** native servers + MCP protocol are live (kills
  `@modelcontextprotocol/sdk`, `zod`, `Bun.serve`).
- **RFC 0006** codebase-health/conformance track is at its bar.

Read-only and maintenance verbs (P7.1–P7.2) can proceed earlier — they ride
the already-native ADStorage/ADContent/ADSearchCascade targets — so the CLI
skeleton + golden harness are not blocked on P6.

## 11. First parity audit (2026-07-05)

The §9 gates ("verb-for-verb golden parity vs `cli.js`", "JS↔Swift corpus parity") had been
declared but never exercised end-to-end. This audit ran a full crawl of the current Swift
corpus (already fresh — 406 roots, 342K+ active pages, same-day) against a full isolated
crawl of the frozen pre-Swift JS implementation as ground truth (`APPLE_DOCS_HOME=/tmp/js-crawl
APPLE_DOCS_NATIVE=off bun cli.js sync --full` — `APPLE_DOCS_NATIVE=off` matters: `cli.js`
otherwise silently delegates most verbs, including reads, to the native Swift binary by
default, which would make the "comparison" compare Swift against itself).

Findings, categorized:

1. **[Confirmed regression — fixed, `ac61e28`]** `roots.page_count` was declared `DEFAULT 0`
   and never incremented anywhere in the write path (verified by grepping the entire
   `ADWrite`/`ADBuilderPipeline`/`ADStorage` write surface). `list_frameworks`/`browse` (CLI
   and MCP tool) and the static build's homepage filter `WHERE page_count > 0`, so they
   silently returned empty against ANY real corpus — `ad-cli frameworks --json` returned
   `{"total":0,"roots":[]}` despite `status --advanced` showing 406 real roots with healthy
   per-root counts. Ported the JS semantics (`repos/roots.js` `updateRootPageCount`, called
   once per root after its crawl loop exhausts — a full recompute from `pages`, not an
   increment) into `CrawlDriver.crawl()`; backfilled the existing corpus via the new hidden
   `ad-cli _backfill-page-count` verb. Verified: 406/406 roots backfilled, `frameworks --json`
   now returns real data.
2. **[New, characterized — root cause not yet pinned down]** `hig`'s reference-following BFS
   re-touches a huge number of already-crawled `apple-docc` pages (~155K in one `sync-all`
   run) without capturing them: `pages`' `ON CONFLICT(path) DO UPDATE` never reassigns
   `root_id`, so each touch updates a pre-existing row in place and stays under its original
   (correct) framework root. Net effect: `hig`'s own progress counters are wildly misleading
   (it's re-fetching, not discovering) and — the real problem — `design` (HIG's actual root)
   ends up with **zero pages** (`ad-cli browse design` → "0 pages"): the HIG source produces
   no usable content in the current corpus. Likely in how `HigAdapter`'s BFS resolves/
   normalizes cross-references before `CrawlDriver.slug(ofKey:)`'s same-root filter applies —
   needs a trace through `DocC.extractReferences`/`Identifier.normalize` to pin down exactly.
   Tracked as a follow-up; the JS crawl (ground truth for HIG's real page count) will confirm
   the expected shape once it completes.
3. **[MCP tool contract diff — mix of known + newly found]** The live JS MCP implementation
   is gone, so pulled the last commit before its deletion (`9078247`'s parent, `200a744`) and
   diffed all 9 tools' schemas field-by-field against `Tools.swift`/`Tools+Inputs.swift`.
   Every Swift input field is a strict subset of JS's — no field was renamed or removed, and
   nothing is Swift-only. `list_taxonomy`, `search_sf_symbols`, and `list_apple_fonts`'
   input are identical. The rest:
   - `read_doc` — schema identical; behavior confirmed diverging exactly as
     `Tools.swift:465-469`'s own comment says. JS's (now-deleted) `pagination.js`/
     `page-builder.js` had a real binary-search paginator (`pageInfo`) and a match-excerpt
     builder; Swift's handler only widens `includeSections`, never truncates or excerpts.
   - `search_docs` — **missing in Swift, not previously flagged anywhere**: JS also has a
     `read` bool (inline the top hit's full doc) plus the same pagination/match shape as
     `read_doc`; Swift has neither.
   - `browse` — **missing in Swift, not previously flagged**: JS paginates the page/children
     array (`maxChars`/`page`); Swift's own `limit` cap (200) with no pagination means a root
     with more pages than the cap is only partially reachable.
   - `list_frameworks` — **newly found, no prior comment anywhere**: `maxChars`/`page` are
     declared right in Swift's own `ListFrameworksInput` schema, but the handler never reads
     either — it always returns the full unpaginated `roots` array regardless of what's
     requested.
   - `render_sf_symbol` / `render_font_text` — schema identical; both have behavioral gaps
     already documented in `Tools.swift`'s own comments (Swift is live-render-only, missing
     JS's disk-cache/prerendered fast path and its CoreText→hb-native→hb-view fallback
     chain; a font-path containment check allows fewer roots) — confirms these are known,
     not new.
   - **Cross-cutting, systemic**: JS's zod schemas reject out-of-range input at decode time;
     Swift's `@SchemaNumber` bounds are advisory-only, clamped server-side instead
     (`QueryParse.swift`'s own comment confirms this is deliberate) — every tool's numeric
     inputs behave differently on out-of-range values, not a per-tool issue.
4. **[Known partial port, deliberately phased]** Several JS `web serve` HTTP routes have no
   `ad-server` equivalent: `/api/fonts/text.svg`, `/api/fonts/subset`, `/api/fonts/file/:id`,
   `/api/fonts/family/:id.zip`, and the `/api/symbols/(scope)/:name.(svg|png)` image-bytes
   pattern. Git history confirms this is a deliberate phase boundary, not an oversight —
   `5ed84c9` ("Completes Phase 2 (fonts + symbols metadata)") explicitly scoped that phase to
   JSON metadata only. The rendering logic itself already exists as the `render_sf_symbol`/
   `render_font_text` MCP tools; it just isn't also exposed as plain HTTP GETs yet.
5. **[Intentional architecture difference]** JS's `web serve` bundles static-site + API in one
   process; Swift splits static generation (`ad-cli web build`) from API/MCP hosting
   (`ad-server serve`), so a bare `ad-server` 404s at `/`. Not a bug, but worth a clearer
   operator-facing note (e.g. in `web deploy`'s printed instructions) — it was surprising in
   practice this session.
6. **[In progress at time of writing]** Per-source/per-framework page-count diff against the
   JS ground truth, and settling #2 with real numbers, are gated on the JS crawl finishing.

Everything above except #6 was confirmed by direct inspection of the running corpus and
codebase, independent of the JS crawl's completion.

## 12. Parity harness design

§3/§9 already name the target; this makes it concrete, composing with what exists rather than
replacing it — the `da57610` schema-fixture gate (`SchemaParityTests`, schema-only, already
reference-flipped per [RFC 0001](0001-swift-native-transition.md) §10) and CI's existing
"JS↔Swift parity against the staged artifact" job (kernel/FFI-level only: native hashing +
search-fusion, 6 spec files).

**Tier 1 — CLI/HTTP verb-for-verb golden diff** (realizes §3/§9 directly). A small,
deterministic, **committed** fixture corpus (a handful of real frameworks, not the full
~340K-page corpus — speed and determinism over coverage) × a fixed arg matrix, driving
`cli.js <verb>` (`APPLE_DOCS_NATIVE=off`) and `ad-cli <verb>` side by side. JSON output
compared intrinsic-equal (parsed, deep-compared, volatile fields like timestamps excluded);
human output byte-for-byte. Proposed home: `swift/Tests/ParityTests/` (Swift Testing,
spawning `bun`/`ad-cli` via `Process`) — matches the existing suite's style.

**Tier 2 — Live server/MCP behavioral diff.** The JS MCP implementation no longer exists
(`src/mcp` deleted; `mcp start`/`mcp serve` unconditionally require `ad-server`, no JS
fallback) — a live JS-vs-Swift MCP run is no longer possible. Per RFC 0001 §10's
reference-flip convention (a frozen-external comparison converts to a self-regression golden
at a domain's first deliberate divergence — exactly `da57610`'s own precedent), this tier is:
(a) Swift-internal transport consistency — stdio `ad-server mcp` and HTTP `POST /mcp` must
agree on every tool's response for the same input — plus (b) schema-contract validation
against a frozen historical snapshot of the JS tool schemas (the last commit before
deletion), regenerated only on a deliberate future contract change. The HTTP-route surface
(JS `web serve` vs Swift `ad-server serve`) is the one place a true live JS-vs-Swift diff is
still possible (JS's non-MCP HTTP server still exists) — folded into Tier 1's arg matrix
rather than a separate tier.

**CI wiring**: extend the existing "JS↔Swift parity" `ci.yml` job (currently kernel/FFI-only)
with Tier 1, rather than adding a new job.

## 13. Outcome

One static Swift binary per platform that serves the entire `cli.js` surface
with byte/contract parity; `package.json` runtime dependencies gone; the TS
toolchain retired with the JS it guarded. The Swift-native transition (P0–P7)
is complete, and every line of new code lands under the unified ADBuildTools
standard from day one.
