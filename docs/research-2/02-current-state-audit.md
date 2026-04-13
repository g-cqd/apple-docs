# Current State Audit: `apple-docs`

This audit is based on the actual local implementation, not just the README.

Key local files inspected include:

- [`package.json`](../../package.json)
- [`cli.js`](../../cli.js)
- [`index.js`](../../index.js)
- [`src/mcp/server.js`](../../src/mcp/server.js)
- [`src/mcp/tools.js`](../../src/mcp/tools.js)
- [`src/storage/database.js`](../../src/storage/database.js)
- [`src/pipeline/discover.js`](../../src/pipeline/discover.js)
- [`src/pipeline/sync-guidelines.js`](../../src/pipeline/sync-guidelines.js)
- [`src/commands/update.js`](../../src/commands/update.js)
- [`src/commands/consolidate.js`](../../src/commands/consolidate.js)
- [`src/commands/search.js`](../../src/commands/search.js)
- [`src/apple/renderer.js`](../../src/apple/renderer.js)

Unit verification run during this audit:

- `bun test`
- Result on 2026-04-13: 53 passing tests, 0 failures

## What The Project Already Does Well

### Strong foundation choices

`apple-docs` already makes several better early decisions than most competitors:

- Bun runtime with no npm dependencies
- Direct use of Apple’s JSON-backed documentation endpoints
- Local SQLite database with FTS5
- Trigram table for substring/title candidate generation
- resumable crawl state
- ETag-aware update flow
- separate raw JSON and Markdown storage
- HIG support via the Apple docs tree
- App Store Review Guidelines support via dedicated HTML parsing

### A good first local architecture

The current project already has the right product split:

- CLI for humans
- MCP server for assistants
- local corpus and database
- sync/update/index workflows

That is the right base to evolve into a platform.

### Search is already meaningfully better than a naive grep wrapper

The search stack is not just “FTS and done”. It already layers:

- FTS title/abstract/path/declaration search
- exact/prefix/contains tiering
- trigram substring search
- Levenshtein fuzzy matching
- optional full-body index

That is enough to justify investing in the current engine rather than replacing it.

## What Exists In Code Today

### Implemented source coverage

Current sources are:

- Apple documentation roots from Apple’s technologies index
- HIG via a special `design` root
- App Store Review Guidelines via an HTML-specific pipeline

Not currently implemented:

- Swift Evolution
- Swift.org docs
- Swift book
- Apple Archive
- Sample code
- WWDC corpus
- package metadata
- package READMEs
- normalized availability metadata

### Current storage model

The local storage model is:

- SQLite metadata database
- raw JSON files on disk
- Markdown files on disk
- optional full-body index built from Markdown

Important consequence:

Markdown is currently a required serving artifact for `read`. If Markdown is missing, the project does not fall back to rendering from raw JSON on demand.

### Current MCP implementation

The current MCP server is custom JSON-RPC over stdio. It is not using the official MCP SDK.

That means:

- minimal protocol surface
- manual line-buffer parsing
- tools only
- no resources
- no prompts
- no standard HTTP transport
- more protocol maintenance burden than necessary

### Current CLI implementation

The CLI currently exposes:

- `search`
- `read`
- `frameworks`
- `browse`
- `sync`
- `update`
- `index`
- `doctor`
- `status`

There is also a separate `apple-docs-mcp` binary via `index.js`.

## High-Value Findings

### 1. The README is ahead of the implementation in a few places

The README is broadly directionally correct, but some behaviors are looser or narrower in code than they sound in docs.

The main example is `doctor`:

- the README presents it as a broad corpus repair command
- the actual implementation is a focused consolidation flow around failed crawl entries, minification, and optional body reindex

That is not a bad command, but it is narrower than the product wording suggests.

### 2. The MCP layer is the biggest architecture seam

The hand-rolled server in [`src/mcp/server.js`](../../src/mcp/server.js) is currently the least future-proof part of the project.

Problems:

- protocol behavior is maintained locally instead of delegated to the official SDK
- no first-class access to standard MCP evolutions
- no clean path to streamable HTTP/server transports
- harder compatibility testing across clients

If `apple-docs` wants to be “more trustworthy”, this is one of the first places to harden.

### 3. The update pipeline is inconsistent for HTML roots

This is the most concrete implementation issue found in the current codebase.

Why:

- [`src/pipeline/sync-guidelines.js`](../../src/pipeline/sync-guidelines.js) stores App Store Review Guidelines pages from HTML
- [`src/apple/api.js`](../../src/apple/api.js) already contains HTML-specific helpers: `fetchHtmlPage` and `checkHtmlPage`
- but [`src/commands/update.js`](../../src/commands/update.js) uses `checkDocPage` for all pages with ETags

That means the update flow is DocC-JSON-centric even for HTML-derived guideline pages. In practice, this creates a correctness risk for guideline updates and deletions.

This should be treated as a real bug, not just a future enhancement.

### 4. Markdown is treated as primary runtime content instead of a cache

Current behavior in [`src/commands/lookup.js`](../../src/commands/lookup.js):

- read page metadata from SQLite
- read Markdown file from disk
- if Markdown is missing, tell the user to sync first

This is the wrong long-term storage contract.

The project already has the raw JSON and a renderer. The canonical source should be the raw source payload plus a normalized internal representation. Markdown should be optional materialization.

### 5. Search metadata is still too coarse for the next stage

The current schema stores:

- path
- title
- role
- abstract
- platforms as strings like `iOS 13+`
- declaration

That is enough for a single-source initial index, but not enough for:

- platform version filtering
- source-aware ranking
- language filtering
- multi-source blending
- sample-code/documentation combined search
- doc freshness and release channels
- static-site search artifact generation

### 6. Distribution and reproducibility are still minimal

Current packaging is intentionally lean, but it lacks:

- lockfile
- TypeScript/types
- lint/typecheck scripts
- artifact build pipeline
- setup/download command
- snapshot verification
- release metadata and checksums

This is where `cupertino` currently wins decisively at the product level.

### 7. Test coverage is good for the age of the repo, but not yet product-grade

The current unit test suite is a solid start for a six-commit repository, but it does not yet cover:

- end-to-end sync
- update correctness
- MCP protocol compatibility
- App Store Review Guidelines update path
- performance regressions
- schema migration safety across real artifacts

## Current Strengths Worth Preserving

These choices should stay:

- Bun runtime
- direct JSON ingestion
- local-first corpus model
- resumable crawl state
- explicit raw source retention
- search tiering beyond simple FTS
- zero-network query behavior after sync

## Current Weaknesses That Must Be Addressed

These are the highest-leverage gaps in the existing codebase itself:

1. Replace the custom MCP protocol implementation with the official SDK.
2. Decouple serving from pre-rendered Markdown files.
3. Normalize content and metadata for a true multi-source corpus.
4. Fix source-specific update handling, especially HTML roots.
5. Add artifact distribution and reproducible release flows.
6. Add a static-web output target from the same normalized content model.

## Short Verdict

`apple-docs` is not architecturally boxed in.

It is an early but well-positioned codebase with:

- a better runtime choice than the main offline competitor
- a cleaner corpus concept than the MCP-only competitors
- a simpler content acquisition path than the WebKit-heavy implementations

Its main problem is not bad design. Its main problem is that it is still at the “strong first draft” stage while competitors have already invested in breadth, packaging, and product surfaces.
