# Phase 9-B: CLI / MCP Command Consolidation

> **Goal**: Reduce the combined surface area of CLI commands and MCP tools by merging overlapping tools, adding flags to existing commands, and removing convenience wrappers that duplicate core functionality — while keeping every name self-explanatory and every invocation concise.

## Motivation

The project currently exposes:

- **CLI**: 16 top-level commands + 10 subcommands = **26 executable commands**
- **MCP**: 8 tools + 2 resources = **10 endpoints**

Several MCP tools are thin wrappers that pre-set a single filter on a core command. This creates maintenance overhead, confuses AI agents with near-duplicate tools, and inflates the tool surface that LLMs must parse in their context window.

## Current Inventory

### MCP Tools (8)

| Tool | Description | Core Command | Wrapper Logic |
|---|---|---|---|
| `search_docs` | Full search with all filters | `search()` | Direct mapping |
| `read_doc` | Read page by path or symbol | `lookup()` | Direct mapping |
| `list_frameworks` | List indexed roots | `frameworks()` | Direct mapping |
| `browse` | Browse topic tree | `browse()` | Direct mapping |
| `status` | Corpus health | `status()` | Direct mapping |
| **`search_wwdc`** | Search WWDC sessions | `search()` | Sets `framework='wwdc'`, adds JS post-filter for `year`/`track` |
| **`search_samples`** | Search sample code | `search()` | Sets `kind='sample-project'` |
| **`read_sample_file`** | Read file from sample project | `lookup()` | Adds section extraction by `file_path` |

### CLI Commands (26)

| Command | Category | Notes |
|---|---|---|
| `search` | Core | Full search — no consolidation needed |
| `read` | Core | Read page — no consolidation needed |
| `frameworks` | Core | List roots — no consolidation needed |
| `browse` | Core | Browse tree — no consolidation needed |
| `sync` | Data | Full sync/crawl |
| `update` | Data | Incremental update check |
| `index` | Data | Build body search index |
| `doctor` | Maintenance | Diagnose + repair |
| `status` | Info | Corpus stats |
| `setup` | Distribution | Download snapshot |
| `snapshot build` | Distribution | Build snapshot archive |
| `mcp start` | MCP | Start stdio server |
| `mcp install` | MCP | Print config JSON |
| `web serve` | Web | Dev server |
| `web build` | Web | Static site builder |
| `web deploy` | Web | Deploy instructions |
| `storage stats` | Storage | Disk usage |
| `storage gc` | Storage | Garbage collect |
| `storage materialize` | Storage | Force-render all docs |
| `storage profile` | Storage | Show/change profile |

## Analysis: Consolidation Candidates

### MCP: High-confidence merges (8 → 5 tools)

#### 1. `search_wwdc` → merge into `search_docs`

**Rationale**: `search_wwdc` is `search_docs` with `framework='wwdc'` and JS post-filtering by `year`/`track`. The `year` and `track` parameters should become first-class params on `search_docs`.

**Changes**:
- Add `year` (number, optional) and `track` (string, optional) params to `search_docs` schema
- Move year/track post-filter logic into `search()` command (shared by CLI and MCP)
- CLI: add `--year` and `--track` flags to `search` command
- Remove `search_wwdc` tool

**Migration**: AI agents using `search_wwdc` can use `search_docs` with `source=wwdc` + `year`/`track`.

#### 2. `search_samples` → merge into `search_docs`

**Rationale**: `search_samples` is `search_docs` with `kind='sample-project'`. The `kind` param already exists on `search_docs`.

**Changes**:
- Remove `search_samples` tool
- No code changes needed — `search_docs` already supports `kind`

**Migration**: AI agents use `search_docs` with `kind=sample-project`.

#### 3. `read_sample_file` → merge into `read_doc`

**Rationale**: `read_sample_file` is `read_doc` + section extraction by file path. Adding a `section` param to `read_doc` makes it strictly more capable.

**Changes**:
- Add `section` (string, optional) param to `read_doc` schema — extracts a named section/file from the document
- Move section-extraction logic from `read_sample_file` into `lookup()` command
- CLI: add `--section` flag to `read` command
- Remove `read_sample_file` tool

**Migration**: AI agents use `read_doc` with `path=sample-code/...` + `section=ContentView.swift`.

### MCP: Tools to keep (5)

| Tool | Reason |
|---|---|
| `search_docs` | Core search — enhanced with `year`, `track` from merge |
| `read_doc` | Core read — enhanced with `section` from merge |
| `list_frameworks` | Unique purpose, no overlap |
| `browse` | Unique purpose, no overlap |
| `status` | Unique purpose, no overlap |

### CLI: Assessment

The CLI commands are already well-organized into namespaced families. The main question is whether any top-level commands should merge.

#### Candidates considered but **rejected**:

| Candidate | Why Rejected |
|---|---|
| Merge `sync` + `update` | Different mental models: `sync` is initial/full crawl, `update` is incremental. Flags would bloat. |
| Merge `index` into `sync`/`update` | `--index` flag already exists on both. Standalone `index` is useful for one-off rebuilds after `doctor`. Keep. |
| Merge `setup` into `sync` | `setup` downloads a pre-built snapshot (< 60s), `sync` crawls Apple APIs (hours). Fundamentally different. |
| Merge `doctor` into `status` | `doctor` mutates data, `status` is read-only. Dangerous to conflate. |
| Merge `frameworks` into `browse` | `frameworks` is a flat list; `browse` is a tree walk. Different output shapes. |

#### CLI enhancements from MCP merges:

| Flag | Command | From |
|---|---|---|
| `--year <n>` | `search` | From `search_wwdc` merge |
| `--track <name>` | `search` | From `search_wwdc` merge |
| `--section <path>` | `read` | From `read_sample_file` merge |

## Consolidated Surface

### Before

| Surface | Count |
|---|---|
| CLI commands | 26 |
| MCP tools | 8 |
| MCP resources | 2 |
| **Total** | **36** |

### After

| Surface | Count | Delta |
|---|---|---|
| CLI commands | 26 | 0 (enhanced with 3 new flags) |
| MCP tools | **5** | **-3** |
| MCP resources | 2 | 0 |
| **Total** | **33** | **-3** |

The MCP tool count drops by 37.5%. More importantly, the **conceptual surface** shrinks: agents see 5 clearly distinct tools instead of 8 with overlapping purposes.

## Tasks

| ID | Task | Depends | Files |
|---|---|---|---|
| 9B.1 | Add `year`/`track` post-filter to `search()` command | — | `src/commands/search.js` |
| 9B.2 | Add `--year` and `--track` CLI flags to `search` | 9B.1 | `cli.js`, `src/cli/help.js` |
| 9B.3 | Add `section` extraction to `lookup()` command | — | `src/commands/lookup.js` |
| 9B.4 | Add `--section` CLI flag to `read` | 9B.3 | `cli.js`, `src/cli/help.js` |
| 9B.5 | Add `year`, `track` params to `search_docs` MCP tool | 9B.1 | `src/mcp/server.js` |
| 9B.6 | Add `section` param to `read_doc` MCP tool | 9B.3 | `src/mcp/server.js` |
| 9B.7 | Remove `search_wwdc` MCP tool | 9B.5 | `src/mcp/server.js` |
| 9B.8 | Remove `search_samples` MCP tool | — | `src/mcp/server.js` |
| 9B.9 | Remove `read_sample_file` MCP tool | 9B.6 | `src/mcp/server.js` |
| 9B.10 | Update MCP contract tests | 9B.5-9 | `test/mcp/contract.test.js` |
| 9B.11 | Update CLI help text and README | 9B.2, 9B.4 | `src/cli/help.js`, `README.md` |

## Risk Assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Breaking AI agent workflows that call `search_wwdc` | Medium | MCP SDK returns `ToolNotFound` — agents retry with `search_docs`. Document migration in tool descriptions. |
| `search_docs` schema becomes too large | Low | 5 → 8 fields still small; all optional. LLMs handle optional params well. |
| Section extraction edge cases in `read_doc` | Low | Keep existing heading/content matching heuristic from `read_sample_file`. |

## Naming Convention Check

Post-consolidation MCP tool names:

| Tool | Verb + Noun | Self-explanatory? | Length |
|---|---|---|---|
| `search_docs` | search + docs | Yes — searches documentation | 11 chars |
| `read_doc` | read + doc | Yes — reads a document | 8 chars |
| `list_frameworks` | list + frameworks | Yes — lists frameworks | 15 chars |
| `browse` | browse (tree) | Yes — browses topic tree | 6 chars |
| `status` | status (health) | Yes — shows corpus status | 6 chars |

All names are ≤ 15 characters, use clear verbs, and have no ambiguity.

## Exit Criteria

- [ ] `search_wwdc` removed; `search_docs` gains `year` + `track` params
- [ ] `search_samples` removed; agents use `search_docs` with `kind=sample-project`
- [ ] `read_sample_file` removed; `read_doc` gains `section` param
- [ ] CLI `search` gains `--year`, `--track` flags
- [ ] CLI `read` gains `--section` flag
- [ ] MCP contract tests updated (removed tools, new params)
- [ ] No CLI command removed (all already well-organized)
- [ ] Help text and README updated
