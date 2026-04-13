# Gap Analysis

This section answers the practical question: what is missing from `apple-docs` if the target is “more complete than the concurrent projects, with a more trustworthy, reliable, fast, efficient, and performant architecture”?

## Capability Matrix

### Source coverage

| Capability | `apple-docs` now | `cupertino` | `OxADD1` archive | `kimsungwhee` MCP | `MightyDillah` MCP | What `apple-docs` should do |
| --- | --- | --- | --- | --- | --- | --- |
| Apple DocC docs | Yes | Yes | Yes | Yes | Yes | Keep as core source |
| HIG | Yes | Yes | No clear first-class support | Partial/live | Partial/live | Keep, normalize as source type |
| App Store Review Guidelines | Yes | Not explicit | No | Partial/live | No | Keep and harden |
| Swift Evolution | No | Yes | No | No | No | Add |
| Swift.org docs | No | Yes | No | No | No | Add |
| Swift book | No | Yes | No | No | No | Add |
| Apple Archive | No | Yes | No | No | No | Add |
| Sample code | No | Yes | No | Yes | No | Add |
| WWDC | No | No | No | Yes | No | Add |
| Package catalog / ecosystem | No | Yes | No | No | No | Add selectively |
| Package READMEs | No | Yes | No | No | No | Add selectively |
| Availability metadata | No normalized model | Yes | No | Yes live analysis | Partial live analysis | Add as first-class indexed metadata |

## Missing Pieces By Area

## 1. Source Breadth Gaps

### Missing source adapters

If `apple-docs` wants to be definitively more complete than the current field, the next source families should be:

1. Swift Evolution proposals
2. Swift.org documentation
3. Swift Programming Language book
4. Apple Archive legacy guides
5. official Apple sample code
6. WWDC transcripts and metadata
7. normalized platform availability metadata

Optional but useful:

- curated Swift package catalog
- selected package READMEs

Why this matters:

- `cupertino` currently wins the “offline Apple knowledge universe” story.
- `kimsungwhee/apple-docs-mcp` wins part of the WWDC and update-awareness story.
- `apple-docs` needs both.

### Missing source abstraction

Today the project mostly has:

- DocC JSON crawling
- one special HTML source

What is missing is a durable source-adapter boundary:

- source identity
- fetch strategy
- update strategy
- canonical normalization
- renderer hooks
- licensing and provenance metadata

Without that layer, each new source will become a special-case pipeline.

## 2. Search Quality Gaps

### What the current engine lacks

Compared with the strongest repos, especially `cupertino`, current missing search features include:

- normalized availability filters:
  - `min_ios`
  - `min_macos`
  - `min_tvos`
  - `min_watchos`
  - `min_visionos`
- source filter and source-type-aware ranking
- language filter
- framework aliases and synonyms
- snippets/highlights
- release-note and changelog down-weighting
- kind-aware ranking that is richer than the current simple tiers
- query-intent-aware boosting
- code-example extraction as a first-class feature
- relationship/teaser surfacing across sources

### What to copy and what not to copy

Worth copying:

- `cupertino` style metadata-rich ranking and filters
- `MightyDillah` style exact symbol + wildcard friendliness
- `kimsungwhee` style helper surfaces around related APIs, updates, and compatibility

Not worth copying as the primary engine:

- `bbssppllvv` query-time OpenAI embedding dependence
- framework-selection gating as the default UX

### Search target state

The target search stack for `apple-docs` should become:

1. Exact path and canonical identifier resolution
2. Title/headings FTS with BM25 and normalized boosts
3. Trigram substring candidate expansion
4. Fuzzy matching on narrowed candidate sets
5. Body search with snippets
6. Source-aware reranking
7. Optional related-result expansion from graph relationships

That is enough to beat the practical utility of the current competitors without turning the system into an embeddings product.

## 3. Trust and Reliability Gaps

### Protocol trust

The custom MCP server is a trust gap.

The fastest fix is:

- use the official MCP SDK
- add contract tests
- support stdio cleanly
- add streamable HTTP transport as an optional runtime

### Artifact trust

`apple-docs` currently lacks:

- signed or at least checksummed artifacts
- reproducible corpus snapshot metadata
- setup/install download verification
- source provenance manifests

To beat `cupertino` on trust, not just speed, `apple-docs` needs:

- a corpus manifest
- per-source checksums
- schema version compatibility rules
- release artifacts with checksums and signature-ready publishing

### Update trust

The HTML root inconsistency means source-aware update logic is currently incomplete.

To be trustworthy:

- every source type must have an explicit fetch/check/update contract
- update metrics must be recorded per source
- failures must be attributable and resumable

## 4. Architecture Gaps

### Missing canonical normalized model

Right now the effective canonical model is:

- raw JSON on disk
- SQLite metadata row
- Markdown file

That is workable, but not sufficient for:

- multi-source normalization
- static web export
- on-demand rendering
- stable snippets
- richer relationship graphs

The missing layer is:

- canonical normalized AST / document model
- stable derived plain-text content
- stable relationships graph

### Missing shared renderer strategy

The project currently renders Markdown from JSON for local files. That is only one output target.

What is missing:

- shared Markdown renderer
- shared HTML renderer
- shared plain-text/snippet renderer
- shared search-field extraction

Without that, static web generation will fork the content logic.

### Missing distribution architecture

Competitors have shown three winning distribution models:

- prebuilt DB download
- npm package with bundled assets
- simple export pipelines

`apple-docs` currently has none of those in a polished form.

It needs:

- `setup` or equivalent
- snapshot build command
- snapshot manifest/checksums
- update-aware artifact naming

## 5. Product Surface Gaps

### Static website

This is entirely missing and is now a clear requirement.

Needed capabilities:

- static page generation
- static search artifacts
- worker-backed client search
- easy deploy target
- local preview
- offline browsing with service worker optionality

### Command taxonomy

This is now a product design gap, not just naming.

Current state:

- CLI is flat
- MCP has a separate binary

Required future state:

- `mcp` namespace for protocol/server concerns
- `web` namespace for site build/preview/serve/deploy
- `build`/`materialize`/`storage` concepts for derived artifacts

## 6. Storage Flexibility Gaps

Current model:

- raw JSON + Markdown + optional body index

Missing:

- raw-only mode
- on-demand Markdown fallback
- on-demand HTML fallback
- cache eviction/materialization commands
- differentiated storage profiles

This is a real competitive gap because one of the user’s requirements is to choose between:

- speed
- disk usage
- portability

## 7. Operational Gaps

### Missing quality gates

Current repo gaps:

- no lint script
- no typecheck script
- no build script for distributable artifacts
- no integration suite
- no CLI e2e suite
- no MCP e2e suite
- no performance benchmarks

### Missing release automation

The project needs:

- GitHub Actions CI
- release builds
- snapshot publishing
- scheduled update workflows
- benchmark workflow

## What To Prioritize First

Not everything missing is equally important.

Highest priority:

1. MCP SDK adoption
2. canonical normalized content model
3. source-adapter architecture
4. normalized availability/source/language metadata
5. distribution and snapshot pipeline

Second priority:

1. source expansion
2. ranking improvements
3. static site generation

Third priority:

1. optional ecosystem/package indexing
2. experimental semantic/graph features

## Short Verdict

To beat the current competitors, `apple-docs` does not need a radically different mission.

It needs to finish the platform it has already started:

- broaden the corpus
- normalize the content model
- harden the protocol layer
- ship verified artifacts
- expose the same corpus through CLI, MCP, and static web outputs

That is the shortest path to “more complete than the concurrent projects” without sacrificing reliability or maintainability.
