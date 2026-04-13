# Implementation Roadmap

This roadmap is intentionally sequenced to maximize leverage and avoid rebuilding the same surfaces twice.

## Success Criteria

`apple-docs` should be considered “more complete than the concurrent projects” when it can satisfy all of these:

- broader or equal meaningful source coverage than `cupertino`
- a verified offline local corpus
- official MCP SDK support
- reproducible snapshot distribution
- fully static web build with client-side dynamic search
- storage profiles that do not require permanent Markdown duplication
- better cross-platform story than the Swift/macOS-only competitor

## Phase 0: Stabilize The Existing Base

Goal:

Create the guardrails needed before deeper architectural changes.

Deliverables:

- add `bun.lock`
- add lint script
- add typecheck path with gradual TypeScript migration
- add integration test harness
- add golden search queries
- add benchmark harness for:
  - sync throughput
  - search latency
  - index build time

Must-fix items:

- fix HTML-root update handling for App Store Review Guidelines
- add `read` fallback rendering when Markdown is missing

Exit criteria:

- CI exists
- the current repo has trustworthy regression protection

## Phase 1: Replace The MCP Core

Goal:

Move MCP to the official TypeScript SDK without expanding scope yet.

Deliverables:

- new MCP server implementation using the official SDK
- stdio parity with current commands
- MCP tool contract tests
- compatibility shim for existing `apple-docs-mcp` usage
- new `apple-docs mcp start` entrypoint

Do not do yet:

- large tool-surface redesign
- web transport unless it is cheap to add

Exit criteria:

- current MCP clients work against the new server
- the hand-rolled server can be retired

## Phase 2: Introduce The Canonical Normalized Content Model

Goal:

Make the corpus independent of pre-rendered Markdown.

Deliverables:

- normalized document schema
- migration strategy from current SQLite layout
- shared renderers:
  - Markdown
  - HTML
  - plain text
  - snippets
- normalized search-field extraction

Behavior changes:

- search indexes no longer depend on Markdown files
- `read` can render on demand from canonical data

Exit criteria:

- Markdown is no longer a correctness dependency
- storage profiles become possible

## Phase 3: Build The Source Adapter Layer

Goal:

Stop adding sources as one-off pipelines.

Deliverables:

- base source adapter contract
- Apple DocC adapter
- HIG adapter
- App Store Review Guidelines adapter
- availability extraction adapter

Important note:

Do not add all new sources before this layer exists.

Exit criteria:

- current sources all use the same adapter model
- source-specific update checking is explicit and tested

## Phase 4: Expand Source Coverage

Goal:

Catch and surpass the strongest competitor on content breadth.

Recommended order:

1. Swift Evolution
2. Swift.org docs
3. Swift book
4. Apple Archive
5. Sample code
6. WWDC
7. package catalog and selected READMEs

Rationale:

- the first four close the largest `cupertino` gaps
- sample code and WWDC close the biggest npm MCP competitor gaps
- packages should be delayed until the core corpus is stable

Exit criteria:

- `apple-docs` has an obvious claim to the broadest practical Apple developer corpus in JavaScript/Bun

## Phase 5: Upgrade Search Quality

Goal:

Make search materially better than both the current local implementation and the MCP-only competitors.

Deliverables:

- availability filters
- source filters
- language filters
- framework aliases and synonyms
- snippets and highlights
- source-aware reranking
- release-note and archive penalties
- code-example-aware boosts
- related-doc graph surfacing

Validation:

- benchmark suite
- golden query suite
- source-specific recall checks

Exit criteria:

- search quality is competitive with or better than `cupertino`
- no runtime model API dependency for core retrieval

## Phase 6: Artifact Distribution And Setup

Goal:

Match or exceed the strongest competitor’s packaging experience.

Deliverables:

- `apple-docs setup`
- snapshot build command
- snapshot verify command
- artifact manifest with checksums
- GitHub Releases publishing
- optional platform binaries compiled with Bun

Design rule:

- distribution must be verifiable
- local rebuild must remain possible

Exit criteria:

- a new user can install and get a working local corpus quickly
- artifacts are auditable

## Phase 7: Static Website

Goal:

Turn the corpus into a deployable static website with dynamic search.

Deliverables:

- `apple-docs web build`
- `apple-docs web preview`
- `apple-docs web serve`
- static HTML generation
- worker-backed client search
- search artifact sharding
- optional service worker
- deploy adapters or documented outputs for:
  - GitHub Pages
  - Cloudflare Pages
  - Netlify
  - S3/CloudFront

Important dependency:

- this phase should not start before the canonical content model and shared renderers exist

Exit criteria:

- fully static deploy succeeds
- search remains fast in browser
- search semantics align with CLI/MCP

## Phase 8: Storage Profiles And Materialization Controls

Goal:

Give users explicit control over disk usage versus read-time speed.

Deliverables:

- `raw-only`
- `balanced`
- `prebuilt`
- materialize commands
- garbage collection commands
- storage stats command

Exit criteria:

- Markdown and HTML are truly optional derived artifacts
- users can reclaim disk without losing correctness

## Phase 9: Hardening, Benchmarks, and Product Polish

Goal:

Turn the platform from “powerful” into “trusted”.

Deliverables:

- scheduled corpus freshness checks
- benchmark history tracking
- corpus integrity verification
- migration tests across snapshot versions
- docs for operators and contributors
- release train and changelog discipline

Exit criteria:

- regressions are visible early
- updates are reliable
- releases are predictable

## Parallelization Plan

Some workstreams can run in parallel once the right prerequisites exist.

Parallel after Phase 2:

- MCP SDK migration hardening
- source adapter implementation
- search metadata schema work

Parallel after Phase 4:

- search ranking improvements
- artifact distribution

Parallel after Phase 5:

- static web build
- storage profile UX

## What Not To Do First

Do not start with:

- embeddings as the primary search engine
- a large React app before the corpus model is stable
- package-ecosystem indexing before the Apple-owned sources are complete
- provider-specific deploy automation before the generic static build exists

These would consume effort without improving the core platform moat.

## Recommended Milestone Order

If the project wants the highest-value path with the least waste, the milestone order should be:

1. Base hardening
2. MCP SDK migration
3. canonical model
4. source adapter layer
5. source expansion
6. search quality
7. distribution/setup
8. static site
9. storage profiles
10. polish and benchmark automation

## End State

At the end of this roadmap, `apple-docs` should look like this:

- Bun-first
- JavaScript/TypeScript
- multi-source offline Apple knowledge platform
- deterministic local search
- official MCP SDK integration
- reproducible downloadable snapshots
- static website build target
- configurable storage/materialization profiles

That is a stronger strategic position than any single concurrent project reviewed here.
