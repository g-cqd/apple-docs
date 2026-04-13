# Phase 9-A: Advanced Web Search Page

> **Goal**: Add a full-page search experience to the web server and static site that exposes the same query dimensions available in the CLI and MCP — framework, source, kind, language, platform, min versions — with URL-driven state and faceted filters.

## Motivation

The current web UI has a **top-bar quick search** powered by a client-side Web Worker scoring against `title-index.json`. It is fast and useful for quick lookups, but limited:

| Dimension | Quick Search (today) | CLI / MCP | Search Page (target) |
|---|---|---|---|
| Full-text query | Title + alias only | FTS5 + trigram + fuzzy + body | FTS5 + trigram + fuzzy + body |
| Framework filter | — | `--framework` | Dropdown / chip |
| Source filter | — | `--source` | Dropdown / chip |
| Kind filter | — | `--kind` | Dropdown / chip |
| Language filter | — | `--language` | Toggle (Swift / ObjC) |
| Platform filter | — | `--platform` | Toggle (iOS / macOS / watchOS / tvOS / visionOS) |
| Min version filters | — | `--min-ios`, etc. | Version input per platform |
| Result limit | 10 (hardcoded) | `--limit` (default 100) | Pagination / load-more |
| Snippet / context | — | Body snippets + related count | Rendered below each result |
| Shareable URL | — | N/A | `?q=...&framework=...&source=...` |
| Intent display | — | Detected intent label | Shown as search refinement hint |

## Architecture

### Route

- **Dev server**: `GET /search` (serve.js)
- **Static site**: `/search/index.html` (build.js)

### Data flow

```
User fills form / URL params
        ↓
  /api/search?q=...&framework=...&source=...&kind=...&language=...&platform=...&limit=...
        ↓
  search() command (src/commands/search.js)
  — full tiered cascade: FTS5 → trigram → fuzzy → body
  — reranking + intent detection + snippet enrichment
        ↓
  JSON response
        ↓
  Client renders results + updates URL
```

### API changes

The existing `/api/search` endpoint already accepts `q`, `framework`, `language`, `source`. Additions needed:

| New param | Maps to | Notes |
|---|---|---|
| `kind` | `opts.kind` | Role filter (symbol, article, collection, sample-project) |
| `platform` | `opts.platform` | Platform shorthand |
| `min_ios` | `opts.minIos` | Version string |
| `min_macos` | `opts.minMacos` | Version string |
| `min_watchos` | `opts.minWatchos` | Version string |
| `min_tvos` | `opts.minTvos` | Version string |
| `min_visionos` | `opts.minVisionos` | Version string |
| `limit` | `opts.limit` | Override default (raise from 10 to 50 for page) |
| `offset` | New: pagination | Skip N results |
| `no_fuzzy` | `opts.fuzzy = false` | Disable fuzzy |
| `no_deep` | `opts.noDeep` | Disable body search |
| `no_eager` | `opts.noEager` | Wait for body search |

### URL-driven state

All filter state lives in query params so searches are **shareable** and **bookmarkable**:

```
/search?q=NavigationStack&framework=swiftui&platform=ios&limit=50
```

The top-bar quick search should gain a "View all results" link that navigates to the search page with the current query pre-filled.

## Tasks

| ID | Task | Depends | Files |
|---|---|---|---|
| 9A.1 | Extend `/api/search` with missing params (kind, platform, min versions, offset, no_fuzzy, no_deep, no_eager) | — | `src/web/serve.js` |
| 9A.2 | Add search page template (`renderSearchPage`) | — | `src/web/templates.js` |
| 9A.3 | Build search page frontend JS (`search-page.js`) | 9A.1, 9A.2 | `src/web/assets/search-page.js` |
| 9A.4 | Add filter panel CSS (facets, chips, responsive) | 9A.2 | `src/web/assets/style.css` |
| 9A.5 | Wire `/search` route in dev server | 9A.1, 9A.2 | `src/web/serve.js` |
| 9A.6 | Generate `/search/index.html` in static build | 9A.2 | `src/web/build.js` |
| 9A.7 | Connect top-bar "View all results" link to search page | 9A.5 | `src/web/assets/search.js` |
| 9A.8 | Tests: API param coverage, template render, URL state | 9A.1-7 | `test/web/search-page.test.js` |

## UI Design

### Layout (desktop)

```
┌─────────────────────────────────────────────────────────────┐
│  [site-name]        [ Search…_________________ ]     [🌗]  │  ← existing header
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Search Results for "NavigationStack"                       │
│  Intent: symbol · 42 results                                │
│                                                             │
│  ┌─ Filters ─────────────────────────────┐                  │
│  │ Framework: [All ▾]                    │                  │
│  │ Source:    [All ▾]                    │                  │
│  │ Kind:      [All ▾]                    │                  │
│  │ Language:  ○ All  ○ Swift  ○ ObjC     │                  │
│  │ Platform:  □ iOS □ macOS □ watchOS    │                  │
│  │            □ tvOS □ visionOS          │                  │
│  │ Min iOS: [____]  Min macOS: [____]    │                  │
│  │ [☐ Fuzzy] [☐ Deep search]            │                  │
│  │                            [Search]   │                  │
│  └───────────────────────────────────────┘                  │
│                                                             │
│  ┌─ Result ──────────────────────────────────────────────┐  │
│  │  NavigationStack                                      │  │
│  │  [SwiftUI] [Structure] [apple-docc]                   │  │
│  │  A view that displays a root view and enables you     │  │
│  │  to present additional views over the root view.      │  │
│  │  snippet: "...Use NavigationStack to manage the..."   │  │
│  │  3 related docs                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌─ Result ──────────────────────────────────────────────┐  │
│  │  ...                                                  │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  [Load more results...]                                     │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Built on 2026-04-13                                        │
└─────────────────────────────────────────────────────────────┘
```

### Layout (mobile)

Filters collapse into an expandable "Filters" disclosure that sits above results. Language/platform use horizontal chip groups instead of radio/checkbox rows.

### Static site support

For the static build, the search page calls the `/api/search` endpoint. In static mode (no server), the search page falls back to the client-side Web Worker with a banner: "Advanced filters require the live server (`apple-docs web serve`)."

## Exit Criteria

- [ ] `/search` page renders with filter form and result list
- [ ] All CLI search dimensions are available as URL query params
- [ ] URL state is bookmarkable and shareable
- [ ] Top-bar quick search shows "View all results →" link
- [ ] Results show framework/source/kind badges, abstracts, snippets, related counts
- [ ] Responsive layout: filter panel stacks on mobile
- [ ] Static build includes `/search/index.html` with graceful fallback
- [ ] Tests cover API param wiring, template rendering, and URL state parsing
