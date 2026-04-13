# Phase 11: Snapshot Tier Awareness & Upgrade Paths

> **Status**: `HISTORICAL PLAN`
> **Live status**: See `docs/plan/PROGRESS.md` — the functional Phase 11 scope is complete as of 2026-04-13 and the tracker contains the verified task/evidence state.
> **Depends on**: Phase 6 (distribution), Phase 8 (storage profiles)
> **Blocks**: Nothing
> **Can parallel with**: Nothing (standalone improvement phase)

## Problem Statement

Snapshot testing revealed 5 bugs that break the lite tier experience and degrade
the standard tier without explanation. The tool has no concept of what tier it's
running on, crashes on startup for lite snapshots, and offers no path to upgrade.

### Bugs Discovered

| # | Bug | Severity | Tier | Root Cause |
|---|---|---|---|---|
| B-01 | Tool crashes on lite startup | **Critical** | Lite | `_prepareStatements()` eagerly prepares queries against `document_sections`, `documents_trigram`, `documents_body_fts`, `pages_body_fts` which don't exist |
| B-02 | `read` returns no content on lite | **High** | Lite | All 3 fallback paths (markdown file, document_sections, raw-json) are absent |
| B-03 | No tier awareness in UI | Medium | All | `snapshot_tier` in `snapshot_meta` is never read at runtime; no user-facing messages |
| B-04 | No upgrade path between tiers | Medium | All | `setup` returns `{status: 'exists'}` when corpus exists; no `--upgrade` or `--force` UX |
| B-05 | Rebuildable indexes not offered | Low | Lite | `documents_trigram` could be rebuilt from `documents.title`; no command exists |

### Tier Capability Matrix (Current State)

| Capability | Lite | Standard | Full |
|---|---|---|---|
| Boot without crash | **NO** | Yes | Yes |
| `status` | Yes | Yes | Yes |
| `frameworks` | Yes | Yes | Yes |
| `browse` | Yes | Yes | Yes |
| `search` (title/abstract/declaration) | Yes | Yes | Yes |
| `search` (trigram/fuzzy) | No | No* | Yes |
| `search` (body) | No | No* | Yes |
| `read` (metadata) | Yes | Yes | Yes |
| `read` (content body) | **NO** | Yes | Yes |
| `doctor` | Yes | Yes | Yes |
| `storage stats/profile` | Yes | Yes | Yes |
| `mcp start` | Crashes | Yes | Yes |

\* Standard keeps `document_sections` but drops trigram/body FTS — these could be rebuilt.

### Target State After Phase 11

| Capability | Lite | Standard | Full |
|---|---|---|---|
| Boot without crash | Yes | Yes | Yes |
| Tier displayed in `status` | Yes | Yes | Yes |
| `search` (trigram/fuzzy) | Rebuildable | Rebuildable | Yes |
| `search` (body) | No (no sections) | Rebuildable | Yes |
| `read` (content body) | Metadata + upgrade hint | Yes | Yes |
| Upgrade to higher tier | Yes | Yes | N/A |
| `doctor` shows tier health | Yes | Yes | Yes |

---

## Architecture Decisions

### AD-01: Tier Detection Strategy

**Decision**: Read `snapshot_tier` from `snapshot_meta` table at startup; cache as `this._tier` on `DocsDatabase`. Fall back to capability probing if `snapshot_meta` is absent (pre-snapshot databases).

**Capability probing fallback**:
```
if snapshot_meta.snapshot_tier exists → use it
else if document_sections table exists AND has rows → 'standard' or 'full'
else if documents table exists → 'lite'
else → 'unknown' (fresh/empty DB)
```

**Rationale**: `snapshot_meta` is the authoritative source (written by `snapshot.js`). Probing handles legacy databases that predate the snapshot system. Cached to avoid repeated queries.

### AD-02: Lazy Statement Preparation

**Decision**: Wrap prepared statements for tier-optional tables in lazy getters. Statements are prepared on first use, not at construction time. If the table doesn't exist, the getter returns `null` and callers handle gracefully.

**Alternative considered**: Create empty stub tables during migration. Rejected because it masks the tier distinction — an empty `document_sections` table is ambiguous (lite snapshot vs. un-synced standard).

**Alternative considered**: `CREATE TABLE IF NOT EXISTS` for missing tables at boot. Rejected for the same ambiguity reason, and because it inflates the DB with empty FTS virtual tables that consume space.

**Implementation pattern**:
```js
get _searchDocumentsTrigram() {
  if (this.__searchDocumentsTrigram === undefined) {
    try {
      this.__searchDocumentsTrigram = this.db.query(`SELECT ...`)
    } catch {
      this.__searchDocumentsTrigram = null
    }
  }
  return this.__searchDocumentsTrigram
}
```

### AD-03: Upgrade as Re-Setup

**Decision**: Upgrade is implemented as `apple-docs setup --tier <higher> --force`. No separate `upgrade` command. The `--force` flag already exists in `setup.js` but is blocked by the `{status: 'exists'}` early return.

**Rationale**: An upgrade is mechanically identical to a fresh setup — download archive, verify, extract, replace DB. A separate command would duplicate all of `setup.js`. The `--force` flag communicates intent clearly.

**Enhancement**: When `--force` is used with an existing corpus, show a confirmation prompt with current vs. target tier and data implications.

### AD-04: Index Rebuild Commands

**Decision**: Add `apple-docs index rebuild-trigram` and `apple-docs index rebuild-body` subcommands. These reconstruct FTS indexes from existing data without requiring raw-json or network access.

**Preconditions**:
- `rebuild-trigram`: Requires `documents` table (all tiers). Creates `documents_trigram` virtual table if missing, then populates from `documents.title`.
- `rebuild-body`: Requires `document_sections` table with rows (standard+ only). Creates `documents_body_fts` virtual table if missing, then populates from section content via `renderPlainText()`.

**Rationale**: These indexes were dropped to reduce snapshot size, but the source data still exists in the DB. Rebuilding locally restores search quality without downloading a larger snapshot.

### AD-05: Graceful Read Degradation on Lite

**Decision**: When `read` is called on a lite snapshot and no content sources are available, return the full metadata envelope (title, abstract, declaration, platforms, relationships) plus a structured `tierLimitation` field explaining the gap and how to resolve it.

**MCP behavior**: The `read_doc` tool returns content with a note: `"Content body unavailable on lite tier. Metadata and declaration shown. Run 'apple-docs setup --tier standard --force' to upgrade."`

**CLI behavior**: Prints metadata in formatted output with a boxed hint at the bottom suggesting upgrade.

---

## Task Breakdown

### Wave 1: Critical Fix (Crash Prevention) — Must ship first

| ID | Task | Status | Files Touched | Depends On |
|---|---|---|---|---|
| 11.1 | Add `getTier()` method to DocsDatabase — reads `snapshot_tier` from `snapshot_meta`, caches result, falls back to capability probing | `pending` | `src/storage/database.js` | — |
| 11.2 | Convert tier-optional prepared statements to lazy getters — `_searchDocumentsTrigram`, `_searchDocumentsBody`, `_documentsBodyIndexCount`, `_documentTrigramCandidates`, `_getDocumentSections`, `_insertDocumentSection`, `_deleteDocumentSections`, `_insertDocumentBody`, `_clearDocumentBody`, `_deleteDocumentBody` | `pending` | `src/storage/database.js` | 11.1 |
| 11.3 | Add `hasTable(name)` utility method to DocsDatabase — `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?` | `pending` | `src/storage/database.js` | — |
| 11.4 | Unit tests for tier detection and lazy statement preparation — lite DB (no sections/trigram/body), standard DB, full DB, legacy DB (no snapshot_meta) | `pending` | `test/unit/database-tier.test.js` | 11.1, 11.2, 11.3 |

### Wave 2: Graceful Degradation — Clear user communication

| ID | Task | Status | Files Touched | Depends On |
|---|---|---|---|---|
| 11.5 | Make `lookup.js` tier-aware — when all content sources fail on lite, return metadata envelope + `tierLimitation` field with upgrade instructions | `pending` | `src/commands/lookup.js` | 11.1 |
| 11.6 | Make `search.js` tier-aware — after search completes, annotate result with `{ trigramAvailable, bodyIndexAvailable, tier }` so callers can show tier hints | `pending` | `src/commands/search.js` | 11.1 |
| 11.7 | Add tier info to `status` command — show current tier, available/unavailable capabilities, upgrade hint if not full | `pending` | `src/commands/status.js` | 11.1 |
| 11.8 | Add tier info to `doctor` command — validate tier-specific invariants (lite: no sections expected, standard: sections expected, full: files expected); warn if invariants violated | `pending` | `src/commands/consolidate.js` | 11.1, 11.3 |
| 11.9 | CLI formatter updates — display tier badge in status, show upgrade hints in read/search when degraded | `pending` | `src/cli/format.js` | 11.5, 11.6, 11.7 |
| 11.10 | Unit tests for graceful degradation — lite read returns metadata + tierLimitation, search annotates tier info, status shows tier | `pending` | `test/unit/tier-degradation.test.js` | 11.5, 11.6, 11.7, 11.8 |

### Wave 3: Upgrade & Rebuild — User agency

| ID | Task | Status | Files Touched | Depends On |
|---|---|---|---|---|
| 11.11 | Enhance `setup.js` for tier upgrades — when `--force` is used with existing corpus, show current tier → target tier transition, download and replace; add `--tier` validation (can't downgrade without explicit `--force --downgrade`) | `pending` | `src/commands/setup.js` | 11.1 |
| 11.12 | Add `index rebuild-trigram` command — creates `documents_trigram` virtual table if missing, populates from `documents.title`, reports count; also recreates insert/update/delete triggers | `pending` | `src/commands/index-rebuild.js`, `cli.js` | 11.3 |
| 11.13 | Add `index rebuild-body` command — checks `document_sections` has rows, creates `documents_body_fts` if missing, populates via `renderPlainText()`, reports count; fails with clear message if sections absent (lite) | `pending` | `src/commands/index-rebuild.js`, `cli.js` | 11.3 |
| 11.14 | CLI wiring for `index rebuild-trigram` and `index rebuild-body` — add to command parser, help text | `pending` | `cli.js`, `src/cli/help.js` | 11.12, 11.13 |
| 11.15 | Unit tests for upgrade and rebuild — setup upgrade flow, trigram rebuild from titles, body rebuild from sections, body rebuild fails gracefully on lite | `pending` | `test/unit/tier-upgrade.test.js`, `test/unit/index-rebuild.test.js` | 11.11, 11.12, 11.13 |

### Wave 4: MCP & Polish — Complete the experience

| ID | Task | Status | Files Touched | Depends On |
|---|---|---|---|---|
| 11.16 | Update MCP `status` tool — include tier, available capabilities, and upgrade hint in response | `pending` | `src/mcp/server.js` | 11.7 |
| 11.17 | Update MCP `read_doc` tool — return metadata + tierLimitation note when content unavailable on lite | `pending` | `src/mcp/server.js` | 11.5 |
| 11.18 | Update MCP `search_docs` tool — include `tier`, `trigramAvailable`, `bodyIndexAvailable` in response metadata | `pending` | `src/mcp/server.js` | 11.6 |
| 11.19 | MCP contract tests — verify tier-aware responses for all 3 tiers | `pending` | `test/mcp/contract.test.js` | 11.16, 11.17, 11.18 |
| 11.20 | Update README — document tier system, capabilities per tier, upgrade instructions, index rebuild commands | `pending` | `README.md` | 11.14 |
| 11.21 | Update snapshot build to also write tier to `schema_meta` — ensures `getTier()` works even if `snapshot_meta` is queried before the snapshot_meta table migration | `pending` | `src/commands/snapshot.js` | 11.1 |

---

## Execution Waves & Parallelism

```
Wave 1 (Critical):  11.1 + 11.3 (parallel) → 11.2 → 11.4
                     ↓
Wave 2 (Degrade):   11.5 + 11.6 + 11.7 + 11.8 (parallel) → 11.9 → 11.10
                     ↓
Wave 3 (Upgrade):   11.11 + 11.12 + 11.13 (parallel) → 11.14 → 11.15
                     ↓
Wave 4 (MCP/Docs):  11.16 + 11.17 + 11.18 (parallel) → 11.19 → 11.20 + 11.21 (parallel)
```

**Minimum viable fix**: Wave 1 alone (tasks 11.1–11.4) unblocks lite snapshots from crashing. This is a ~30-minute fix that should ship immediately.

**Minimum viable experience**: Waves 1 + 2 (tasks 11.1–11.10) give users clear feedback about what works and what doesn't on their tier. This covers the critical UX gap.

---

## Exit Criteria

### Wave 1 (Critical Fix)
- [ ] Lite snapshot boots without crash — no manual stub tables needed
- [ ] All existing tests pass unchanged (no regression)
- [ ] `_prepareStatements()` does not query tier-optional tables eagerly
- [ ] `getTier()` returns correct tier for lite/standard/full/legacy databases

### Wave 2 (Graceful Degradation)
- [ ] `read` on lite returns metadata envelope with `tierLimitation` field
- [ ] `search` results include `tier` and capability flags
- [ ] `status` displays current tier and capability matrix
- [ ] `doctor` validates tier-specific invariants
- [ ] CLI output shows tier badge and upgrade hints where relevant

### Wave 3 (Upgrade & Rebuild)
- [ ] `apple-docs setup --tier standard --force` downloads and replaces lite with standard
- [ ] `apple-docs setup --tier full --force` downloads and replaces with full
- [ ] Downgrade requires explicit `--force --downgrade` (safety guard)
- [ ] `apple-docs index rebuild-trigram` rebuilds trigram FTS from `documents.title`
- [ ] `apple-docs index rebuild-body` rebuilds body FTS from `document_sections` (standard+ only)
- [ ] `index rebuild-body` on lite fails with clear message explaining sections are absent
- [ ] After `rebuild-trigram`, fuzzy search works on lite/standard
- [ ] After `rebuild-body`, body search works on standard

### Wave 4 (MCP & Polish)
- [ ] MCP `status` includes tier info
- [ ] MCP `read_doc` returns tier limitation note on lite
- [ ] MCP `search_docs` includes tier capability metadata
- [ ] MCP contract tests cover all 3 tiers
- [ ] README documents tier system, upgrade paths, and rebuild commands

---

## Key Artifacts (Planned)

| File | Purpose |
|---|---|
| `src/storage/database.js` | `getTier()`, `hasTable()`, lazy prepared statements |
| `src/commands/lookup.js` | Tier-aware read with `tierLimitation` field |
| `src/commands/search.js` | Tier capability annotations on search results |
| `src/commands/setup.js` | Upgrade support via `--force` with tier transition |
| `src/commands/index-rebuild.js` | `rebuildTrigram()` and `rebuildBody()` commands |
| `src/commands/status.js` | Tier display with capability matrix |
| `src/commands/consolidate.js` | Tier-specific doctor checks |
| `src/mcp/server.js` | Tier-aware MCP tool responses |
| `test/unit/database-tier.test.js` | Tier detection and lazy statements |
| `test/unit/tier-degradation.test.js` | Graceful degradation paths |
| `test/unit/index-rebuild.test.js` | Index rebuild commands |
| `test/mcp/contract.test.js` | MCP tier-aware contract tests |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lazy getters introduce subtle null-check bugs in callers | Medium | High | Every caller that uses a tier-optional statement must check for null; add lint rule or helper |
| `rebuild-trigram` on 334K documents is slow | Low | Low | It's a single INSERT...SELECT; SQLite handles this in seconds |
| `rebuild-body` on 334K sections is slow | Medium | Medium | Use batch processing with progress reporting (reuse `index-body.js` pattern) |
| Upgrade replaces DB but WAL/SHM files interfere | Low | High | Already handled in `setup.js` — deletes WAL/SHM before extraction |
| Pre-snapshot databases lack `snapshot_meta` table | Medium | Medium | Capability probing fallback handles this case |

---

## Estimation

| Wave | Tasks | Estimated Effort | Cumulative |
|---|---|---|---|
| Wave 1 (Critical) | 11.1–11.4 | Small | Small |
| Wave 2 (Degrade) | 11.5–11.10 | Medium | Medium |
| Wave 3 (Upgrade) | 11.11–11.15 | Medium | Medium-Large |
| Wave 4 (MCP/Docs) | 11.16–11.21 | Small-Medium | Large |

---

## Execution Log

This file remains the original phase plan. The execution log and validated completion evidence now live in `docs/plan/PROGRESS.md`.
