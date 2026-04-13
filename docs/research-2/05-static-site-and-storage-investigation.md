# Static Site, Command Taxonomy, and Storage Investigation

This document addresses three linked requirements:

1. Serve the corpus as a static website with dynamic search
2. Reserve `serve` / `deploy` semantics for the web output
3. Investigate on-demand Markdown instead of mandatory preconversion

## Part 1: Command Taxonomy

The current project has:

- `apple-docs` for the CLI
- `apple-docs-mcp` as a separate MCP binary

That model conflicts with the requested product semantics because:

- “serve” should belong to the website
- MCP startup is not really “serving” a web property
- the project is growing into multiple output modes

## Recommended command model

### Top-level namespaces

Use explicit subnamespaces:

- `apple-docs sync`
- `apple-docs search`
- `apple-docs read`
- `apple-docs index`
- `apple-docs status`
- `apple-docs setup`
- `apple-docs mcp ...`
- `apple-docs web ...`
- `apple-docs snapshot ...`
- `apple-docs storage ...`

### MCP commands

Recommended:

- `apple-docs mcp start`
- `apple-docs mcp stdio`
- `apple-docs mcp http`
- `apple-docs mcp inspect`

Preferred default:

- `apple-docs mcp start`

Optional shorthand:

- `apple-docs mcp`

Reason:

- it is explicit
- it preserves `serve` for the web surface
- it scales if HTTP transport is added later

### Web commands

Recommended:

- `apple-docs web build`
- `apple-docs web preview`
- `apple-docs web serve`
- `apple-docs web deploy`

Semantics:

- `build` creates static output
- `preview` runs a local preview against built artifacts
- `serve` serves the static site locally over HTTP
- `deploy` publishes or prepares deployment adapters

### Compatibility plan

Do not break existing users immediately.

Use a staged transition:

1. keep `apple-docs-mcp` as a compatibility shim
2. add `apple-docs mcp start`
3. document the new path first
4. deprecate the old binary in a later major release

## Part 2: Static Site Architecture

The static site should not be treated as a separate app that happens to consume exported Markdown.

It should be a first-class build target of the same corpus.

## Recommended output model

Build a static directory such as:

```text
dist/web/
  index.html
  assets/
  docs/
    swiftui/
    foundation/
    ...
  data/
    manifest.json
    search/
      title-index.json
      trigram/
      body/
      aliases.json
      snippets.json
  worker/
    search-worker.js
```

## Static site rendering rules

Each page should be prebuilt as HTML from the normalized document model.

Each page should also have lightweight machine-readable companion data available for:

- client search
- inline previews
- related-doc navigation
- offline caching

## Dynamic search in a static site

The site must remain static, which means the search has to run entirely in the browser.

### Recommended search architecture

Use a Web Worker and generated search artifacts.

Search stages in the browser:

1. exact/path/title lookup using a small eagerly-loaded manifest
2. alias expansion
3. trigram/title/body shard loading based on query terms
4. BM25-like or weighted scoring in the worker
5. snippet rendering from precomputed or compact body fragments
6. fuzzy fallback on narrowed result sets

### Why a worker

Without a worker:

- indexing and scoring block the UI
- mobile performance degrades

With a worker:

- same search logic can run off the main thread
- large corpora stay usable

### Recommended artifact strategy

Do not ship one giant JSON blob.

Instead generate:

- a small root manifest
- per-framework or per-prefix title shards
- per-term-range or per-framework body shards
- snippets separately

This keeps first load fast while allowing full static deployment.

## Search strategy alignment with CLI/MCP

The static site should reuse the same ranking philosophy as the local engine:

- exact
- prefix
- contains
- trigram substring
- fuzzy
- body/snippet

That means the “searching strategies” remain shared conceptually across:

- CLI
- MCP
- web

The implementation may differ at the storage/artifact layer, but the ranking semantics should stay aligned.

## Should the web use SQLite WASM?

There are two viable approaches.

### Option A: Generated JSON shards plus custom worker scoring

Pros:

- simplest deploy story
- easy to control payload sizes
- easy to debug
- aligns well with existing JS/Bun code

Cons:

- more custom code
- less reuse of SQLite query semantics

### Option B: Ship a browser-side SQLite/WASM search artifact

Pros:

- more direct reuse of SQLite semantics
- easier parity with local search if carefully designed

Cons:

- larger payloads
- more fragile browser/runtime behavior
- more complex caching story

### Recommendation

For this project, prefer Option A first.

Reason:

- fully static deployability is more important than exact engine parity
- Bun and JavaScript should remain the center of gravity
- a sharded worker-based index gives better control over performance and size

SQLite/WASM can be an experimental later profile, not the default.

## Part 3: Markdown Storage Investigation

The current system writes Markdown to disk during sync and depends on it for `read`.

That is useful, but it should not remain the only runtime model.

## Storage profiles to support

### Profile 1: `raw-only`

Stores:

- raw source payloads
- normalized metadata
- search index

Does not store:

- pre-rendered Markdown
- pre-rendered HTML

Behavior:

- render Markdown/HTML on demand

Best for:

- lowest disk usage
- CI agents
- headless MCP-only setups

### Profile 2: `balanced`

Stores:

- raw source payloads
- normalized metadata
- search index
- hot rendered cache

Behavior:

- render on first read
- cache rendered Markdown/HTML
- evict with storage rules

Best for:

- most local developers
- predictable UX without full duplication

### Profile 3: `prebuilt`

Stores:

- raw source payloads
- normalized metadata
- search index
- full Markdown
- full HTML or web build artifacts

Best for:

- offline-first power users
- export-heavy workflows
- snapshot and distribution builds

## Recommended default

Default to `balanced`.

Reasons:

- faster than raw-only after warm-up
- much less storage-heavy than mandatory full materialization
- suitable for both local CLI and MCP

## Recommended behavior changes

### `read` behavior

If Markdown file does not exist:

1. load raw payload
2. normalize if needed
3. render Markdown on the fly
4. return it immediately
5. optionally cache it depending on storage profile

This should replace the current “Markdown not yet generated” behavior.

### Search indexing behavior

Search indexes should derive from normalized text, not from the Markdown files on disk.

Why:

- search should not depend on whether Markdown materialization ran
- Markdown is a presentation artifact
- plain text/search fields should come directly from normalized content

## Proposed storage commands

Recommended commands:

- `apple-docs storage profile set raw-only|balanced|prebuilt`
- `apple-docs storage materialize markdown`
- `apple-docs storage materialize html`
- `apple-docs storage gc`
- `apple-docs storage stats`

Examples:

- `apple-docs storage profile set raw-only`
- `apple-docs storage materialize markdown --roots swiftui,foundation`
- `apple-docs storage gc --drop markdown,html`
- `apple-docs storage stats`

## Disk-space tradeoff model

At a high level:

- raw payloads are required for provenance and rebuildability
- search text is required for search quality
- Markdown and HTML are optional convenience layers

That means the right rule is:

- never make the convenience layers mandatory for correctness

## Part 4: Recommended Product Shape

The cleanest future product model is:

- `apple-docs sync` builds and updates the corpus
- `apple-docs mcp start` exposes the corpus to assistants
- `apple-docs web build` creates a static website
- `apple-docs web serve` previews it locally
- `apple-docs web deploy` publishes it
- `apple-docs storage ...` controls derived materialization and disk tradeoffs

## Short Verdict

The user requirement is correct:

- `serve` should belong to the web output
- MCP startup should move under a subnamespace
- Markdown should become optional derived content

The most coherent resulting design is:

- `mcp` namespace for protocol/server behavior
- `web` namespace for site behavior
- `storage` namespace for raw-vs-derived artifact control

That gives the project a much clearer product model while preserving the strength of the local corpus architecture.
