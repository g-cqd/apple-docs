# Target Architecture Proposal

```xml
<analysis>
  <Objective>
    Transform apple-docs from an early Bun-based offline Apple documentation tool into the most complete and trustworthy local Apple documentation platform, capable of powering CLI, MCP, and fully static web deployments from one shared corpus.
  </Objective>

  <Requirements>
    <Functional>
      Index Apple DocC, HIG, App Store Review Guidelines, Swift Evolution, Swift.org, Swift book, Apple Archive, WWDC, sample code, and selected package metadata. Expose shared search and document rendering through CLI, MCP, and a static website.
    </Functional>
    <NonFunctional>
      <Scalability>Support hundreds of thousands of documents locally, fast incremental updates, and browser-safe sharded web search artifacts.</Scalability>
      <Availability>Local CLI/MCP search should remain available without network access once data is synced. Static site should deploy to commodity static hosting.</Availability>
      <RTO_RPO>Corpus rebuild should be reproducible from source manifests; snapshot restore should be possible from verified artifacts.</RTO_RPO>
      <Compliance>No special regulatory target identified. Respect source provenance, artifact verification, and safe default rate limiting toward upstream sources.</Compliance>
    </NonFunctional>
  </Requirements>

  <CurrentState>
    Bun-based JavaScript codebase with SQLite FTS5, raw JSON plus Markdown storage, direct Apple DocC ingestion, HIG and App Store Review Guidelines support, custom MCP server, and unit tests. No official MCP SDK, no static web build, no artifact distribution, and no multi-source normalized schema.
  </CurrentState>

  <ProposedArchitecture>
    Introduce a canonical normalized content model shared by source adapters, search, rendering, MCP, and static site generation. Keep Bun as runtime, migrate progressively to TypeScript for safety, use the official MCP SDK, and make Markdown/HTML derived outputs optional rather than primary storage.
  </ProposedArchitecture>

  <KeyComponents>
    Bun runtime, TypeScript (progressive migration), bun:sqlite, official MCP TypeScript SDK, normalized document graph, source adapter layer, shared renderers, snapshot/distribution pipeline, static web build pipeline, GitHub Actions CI/CD.
  </KeyComponents>

  <IaC_Strategy>
    Keep deployment surface simple: GitHub Actions for build/test/release, optional static host adapters for GitHub Pages, Cloudflare Pages, Netlify, and S3/CloudFront. Avoid heavyweight infrastructure until the artifact model stabilizes.
  </IaC_Strategy>

  <CI_CD_Strategy>
    Lint, typecheck, unit tests, integration tests, build snapshots, verify corpus manifests, benchmark key search paths, publish release artifacts, and deploy static site from immutable build outputs.
  </CI_CD_Strategy>

  <SecurityConsiderations>
    Verified artifact checksums, no runtime dependency on external model APIs for core retrieval, minimal secret surface, provenance metadata per source, safe rate limiting and retry policies, and strict separation of local read APIs from write/update commands.
  </SecurityConsiderations>

  <ObservabilityPlan>
    Structured logs, source-level sync metrics, corpus manifest versioning, benchmark snapshots, artifact verification logs, and regression checks for search latency and update correctness.
  </ObservabilityPlan>

  <Risks>
    <Risk name="Scope Creep">Mitigation: Sequence source expansion after the normalized model and MCP hardening are in place.</Risk>
    <Risk name="Artifact Bloat">Mitigation: Make Markdown and HTML optional derived caches with explicit storage profiles.</Risk>
    <Risk name="Search Regression During Refactor">Mitigation: Add golden-query and latency benchmark suites before replacing the current engine.</Risk>
    <Risk name="Upstream Contract Drift">Mitigation: Encapsulate every source behind adapters with source-specific tests and manifests.</Risk>
  </Risks>
</analysis>
```

## Architecture Principles

The target architecture should follow these rules:

1. Source payloads are canonical truth.
2. Normalized documents are the internal shared model.
3. Markdown and HTML are materializations, not required storage primitives.
4. Search is deterministic and offline-first by default.
5. MCP and web should reuse the same document and search services.
6. The system should degrade by source, not fail globally.

## Recommended Technology Direction

### Runtime

Keep Bun as the runtime and package manager.

Reasons:

- excellent fit for `bun:sqlite`
- low dependency surface
- good single-runtime story for CLI, build tooling, and local preview server
- aligns directly with the user requirement to leverage Bun and JavaScript as much as possible

### Language

Move progressively to TypeScript, not away from JavaScript.

Recommended migration style:

- add `tsconfig.json`
- enable `allowJs` initially
- migrate hot modules first
- keep Bun runtime unchanged

Why:

- this adds trust and maintainability without losing the Bun/JS identity
- source adapters and schema-heavy code benefit materially from types

## Proposed Module Layout

```text
src/
  core/
    config/
    logging/
    errors/
    metrics/
    types/
    schemas/

  sources/
    base/
    apple-docc/
    hig/
    app-store-review/
    swift-evolution/
    swift-org/
    swift-book/
    apple-archive/
    sample-code/
    wwdc/
    packages/
    availability/

  content/
    normalize/
    graph/
    render-markdown/
    render-html/
    render-text/
    snippets/

  storage/
    sqlite/
    migrations/
    blobs/
    snapshots/
    profiles/

  search/
    query/
    ranking/
    filters/
    aliases/
    exact/
    fuzzy/
    body/

  services/
    documents/
    search/
    updates/
    setup/
    web/
    mcp/

  cli/
    commands/
    formatters/

  mcp/
    server/
    tools/
    resources/

  web/
    build/
    assets/
    search-worker/
    templates/
```

## Canonical Content Model

The single most important architectural addition is a normalized document model.

### Why the current model is not enough

The current project can read and render Apple JSON successfully, but it still effectively treats each storage format as a direct product artifact:

- raw JSON
- Markdown
- body index

For a truly shared platform, you need a canonical model that is independent of the output format.

### Recommended normalized entities

Minimum durable entities:

- `sources`
  - source id
  - source type
  - fetch strategy
  - provenance metadata
- `documents`
  - canonical id
  - source id
  - source document key
  - title
  - kind
  - framework / collection
  - url
  - language
  - timestamps
  - deprecation / beta / archival flags
- `document_variants`
  - raw payload hash
  - normalized content hash
  - rendered markdown hash
  - rendered html hash
- `document_sections`
  - section kind
  - heading
  - normalized text
  - code blocks
- `document_relationships`
  - from id
  - to id
  - relation type
- `document_availability`
  - min iOS/macOS/tvOS/watchOS/visionOS
  - deprecated / obsoleted values
  - source confidence
- `search_documents`
  - normalized search text
  - title text
  - headings text
  - declaration text
  - source type
  - ranking fields
- `artifacts`
  - snapshot id
  - checksum
  - schema version
  - build profile

### Result

Once this exists, the rest becomes simpler:

- MCP reads from services backed by normalized documents
- CLI reads from the same services
- static site build reads from the same services
- Markdown and HTML can be regenerated any time

## Source Adapter Model

Every source should implement the same contract:

- `discover()`
- `fetch(documentKey)`
- `check(documentKey, previousState)`
- `normalize(rawPayload)`
- `relationships(normalizedDoc)`
- `availability(normalizedDoc)`
- `renderHints(normalizedDoc)`

This avoids repeating today’s “DocC pipeline plus exceptions” pattern.

### Priority adapter order

1. `apple-docc`
2. `hig`
3. `app-store-review`
4. `availability`
5. `swift-evolution`
6. `swift-org`
7. `swift-book`
8. `apple-archive`
9. `sample-code`
10. `wwdc`

Packages can wait until the core platform is hardened.

## Search Architecture

The target search architecture should remain deterministic and local-first.

### Retrieval stages

1. Exact path / identifier match
2. Alias-expanded title search
3. FTS title/headings/declaration search
4. Trigram candidate expansion
5. Fuzzy refinement
6. Body search with snippets
7. Source-aware reranking

### Metadata needed for good ranking

- source type
- document kind
- framework alias matches
- availability match score
- modern vs archived vs release-note status
- code-example presence
- relationship density
- title-depth/path-depth features

### Recommended ranking approach

Use weighted deterministic heuristics, not opaque model scoring:

- boost exact and alias hits strongly
- boost core symbol kinds for symbol-like queries
- boost guides/articles for “how do I” style queries
- down-rank release notes except for release/update-intent queries
- boost code-heavy pages for implementation-intent queries
- down-rank archived content unless explicitly requested

This is how `apple-docs` can beat the semantic-search MCPs on trust.

## Rendering Architecture

Use shared rendering services from the normalized model:

- Markdown renderer
- HTML renderer
- plain text renderer
- snippet extractor

Important rule:

- do not make HTML generation depend on Markdown generation

Instead:

- both should be siblings built from the same normalized content tree

That preserves fidelity and avoids turning Markdown into a lossy intermediate format for the website.

## MCP Architecture

### Recommended target

Use the official TypeScript MCP SDK for:

- stdio server
- typed tool registration
- resource support
- transport evolution

### Tool surface direction

Recommended high-level tools:

- `search_docs`
- `read_doc`
- `list_sources`
- `list_frameworks`
- `get_related_docs`
- `search_samples`
- `read_sample`
- `search_wwdc`
- `read_wwdc`
- `get_updates`

Also add resource URIs for stable retrieval:

- `apple-docs://doc/{id}`
- `apple-docs://sample/{id}`
- `apple-docs://wwdc/{id}`

## Distribution Architecture

`apple-docs` needs a first-class snapshot pipeline.

### Artifact types

- search snapshot database
- metadata manifest
- source manifests
- optional web build bundle
- optional Markdown bundle

### Artifact rules

- immutable by version and snapshot date
- checksum verified
- schema version embedded
- build profile embedded

### Commands enabled by this

- `apple-docs setup`
- `apple-docs snapshot build`
- `apple-docs snapshot verify`
- `apple-docs snapshot fetch`

## CI/CD

Minimum GitHub Actions pipeline:

1. install Bun
2. lint
3. typecheck
4. unit tests
5. integration tests
6. build CLI/MCP artifacts
7. build snapshot metadata
8. benchmark search
9. publish release artifacts
10. optionally deploy web bundle

## What This Architecture Solves

Compared with the current codebase, this architecture fixes:

- the protocol fragility of the custom MCP server
- the storage rigidity of Markdown-as-required-output
- the source-silo problem
- the missing web output path
- the missing artifact distribution path

Compared with competitors, it creates a better combined position:

- more portable than `cupertino`
- more trustworthy than the live npm MCP wrappers
- more productized than the Python archive scripts
- more deterministic than the embedding-first search packages

## Short Verdict

The right destination for `apple-docs` is:

- Bun runtime
- JavaScript/TypeScript implementation
- normalized multi-source corpus
- deterministic search
- shared rendering
- official MCP SDK
- static web output from the same data model

That is the architecture most likely to become both more complete and more reliable than the current field.
