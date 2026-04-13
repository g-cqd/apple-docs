# Phase 10-A: Collection Type Filters

> **Goal**: Add quick-filter chips to all collection listing pages (home page, framework pages, document Topics sections) so users can show/hide items by type with multi-select support — by framework `kind` on the home page, by `role_heading` on framework and document pages.

## Motivation

Framework listing pages (`/docs/swiftui/`) and document pages with Topics sections can contain hundreds of items spanning many symbol types. Currently the only organization is grouping by `role` or topic title — there is no way to narrow the view to just the types you care about.

| Scenario | Today | Target |
|---|---|---|
| "Show me only Protocols in SwiftUI" | Scroll through all role groups manually | Click `Protocol` chip → only protocol groups shown |
| "Show Structures and Classes" | Mentally filter while scrolling | Click `Structure` + `Class` → others hidden |
| "Filter topics on a class page" | No filtering | Chips for child document types (method, property, enum case) |
| "Show only frameworks on home page" | Scroll past grouped kinds | Click `framework` kind chip → only frameworks shown |
| "Reset filters" | N/A | Click `All` chip or deselect all |

## Architecture

### Data model

All filtering data already exists in the database:

| Field | Source | Usage |
|---|---|---|
| `role_heading` | `documents.role_heading` | Primary filter dimension — human-readable type label |
| `role` | `documents.role` | Grouping key on framework pages |
| `kind` | `documents.kind` | Secondary classification (symbol, article, collection, sampleCode) |

**Home page** (`renderIndexPage`) lists frameworks grouped by `kind` (e.g., "framework", "tool", "guide"). Each `<section class="framework-group">` has a kind heading and a list of framework links. The `kind` field is the natural filter dimension here.

**Framework pages** already receive documents with `role_heading` — it's rendered as `.doc-item-meta` in `renderFrameworkPage`.

**Topics sections** store items as `{ key, title, identifier }` in `content_json` — they do **not** carry `role_heading`. The item's type must be resolved by looking up the linked document in the `documents` table during rendering.

### Approach

**Client-side filtering** via `data-*` attributes + vanilla JS toggle:

1. Server renders each filterable item with `data-role-heading="Protocol"` (or equivalent) as an HTML attribute
2. A JS module scans the page for these attributes, extracts distinct values, and builds a chip bar
3. Clicking chips toggles CSS `display` on matching items — no server round-trip, works in static builds
4. URL fragment stores filter state (`#filter=Protocol,Structure`) for shareability

### Rendering changes

**Home page** (`renderIndexPage`):
- Add `data-filter-kind` attribute to each `<section class="framework-group">` from the kind group key
- Add `data-filter-kind` attribute to each `<li>` in `.framework-list`
- Insert a `<div class="collection-filter-bar">` placeholder before framework group sections

**Framework pages** (`renderFrameworkPage`):
- Add `data-filter-kind` attribute to each `<li>` in `.doc-list` (using `role_heading` value)
- Add `data-filter-kind` attribute to each `<section class="role-group">`
- Insert a `<div class="collection-filter-bar">` placeholder before role sections

**Document pages** (`renderDocumentPage`):
- For Topics sections, resolve each item's `role_heading` from the `documents` table during rendering
- Add `data-filter-kind` attribute to each `<li>` in topic group lists
- Insert a `<div class="collection-filter-bar">` placeholder before topics content

> Note: A single `data-filter-kind` attribute is used across all page types for a uniform JS scanner. The *value* comes from `kind` on the home page and `role_heading` on framework/document pages.

### Static build considerations

For the static build, the topics section enrichment requires a batch DB lookup during `buildStaticSite`. The build already queries `document_sections` per document — adding a secondary lookup for topic item metadata is a bounded cost (number of items per topics section is typically < 100).

### UI design

#### Filter bar (desktop)

```
┌─────────────────────────────────────────────────────────┐
│  Filter: [All] [Protocol ·12] [Structure ·45]           │
│          [Class ·8] [Enumeration ·15] [Function ·23]    │
│          [Article ·3] [Type Alias ·7]                   │
├─────────────────────────────────────────────────────────┤
│  Protocol (12)                                          │
│  ├─ View                                                │
│  ├─ Scene                                               │
│  └─ ...                                                 │
│                                                         │
│  Structure (45)                                         │
│  ├─ Text                                                │
│  └─ ...                                                 │
└─────────────────────────────────────────────────────────┘
```

#### Filter bar (mobile)

Chips wrap horizontally and scroll. Counts are hidden on narrow viewports to save space.

#### Multi-select behavior

| Action | Result |
|---|---|
| No chip selected (default) | All items visible |
| Click one chip | Only that type visible; chip highlighted |
| Click additional chip | Add that type to visible set (OR logic) |
| Click active chip | Remove that type from visible set |
| Click "All" chip | Reset — all items visible |

## Tasks

| ID | Task | Depends | Files |
|---|---|---|---|
| 10A.1 | Add `data-filter-kind` attributes to `renderIndexPage` framework groups and list items (value = `kind`) | — | `src/web/templates.js` |
| 10A.2 | Add `data-filter-kind` attributes to `renderFrameworkPage` role groups and list items (value = `role_heading`) | — | `src/web/templates.js` |
| 10A.3 | Add `data-filter-kind` to Topics section items via DB lookup during rendering (value = resolved `role_heading`) | — | `src/web/templates.js`, `src/content/render-html.js` |
| 10A.4 | Add `<div class="collection-filter-bar">` placeholder to index, framework, and document page templates | 10A.1-3 | `src/web/templates.js` |
| 10A.5 | Build `collection-filters.js` — scan `data-filter-kind`, build chips with counts, toggle visibility, URL fragment state, multi-select | 10A.4 | `src/web/assets/collection-filters.js` |
| 10A.6 | Add filter chip CSS (chip bar layout, active/inactive states, counts badge, responsive wrap, scroll on mobile) | 10A.4 | `src/web/assets/style.css` |
| 10A.7 | Wire `collection-filters.js` into index, framework, and document page `<script>` tags | 10A.5 | `src/web/templates.js` |
| 10A.8 | Pass DB context to topic item rendering in `buildStaticSite` and `startDevServer` for role_heading resolution | 10A.3 | `src/web/build.js`, `src/web/serve.js` |
| 10A.9 | Copy `collection-filters.js` in static build asset pipeline | 10A.5 | `src/web/build.js` |
| 10A.10 | Tests: data-attribute rendering on all 3 page types, chip generation, multi-select toggle, URL fragment parsing | 10A.1-9 | `test/unit/web-templates.test.js`, `test/unit/web-collection-filters.test.js` |

## Key decisions

| # | Decision | Rationale |
|---|---|---|
| D-01 | Client-side filtering via data attributes | Zero server load, works in static builds, instant response |
| D-02 | `role_heading` as primary filter dimension | Most meaningful to users ("Protocol", "Structure"); already populated for all DocC sources |
| D-03 | URL fragment (`#filter=...`) not query params | Avoids server round-trip on static pages; does not conflict with search page query params |
| D-04 | Chip counts rendered at build time | Counts are static per page — no JS computation needed |
| D-05 | OR-logic multi-select | Most intuitive for "show me these types" use case |
| D-06 | Topics section enrichment via DB lookup | Required because topics `content_json` items lack `role_heading`; bounded cost per page |

## Exit criteria

- [ ] Home page shows a filter chip bar with distinct framework `kind` values and counts
- [ ] Framework pages show a filter chip bar with distinct `role_heading` values and counts
- [ ] Clicking one or more chips filters the listing to matching types only (OR logic)
- [ ] "All" chip resets the filter
- [ ] Filter state persists in URL fragment (`#filter=Protocol,Structure`) and is shareable
- [ ] Document pages with Topics sections show a filter chip bar for child document types
- [ ] Topics items are enriched with `data-filter-kind` from the `documents` table
- [ ] Filter chips wrap responsively on mobile
- [ ] Empty groups are hidden when all their items are filtered out
- [ ] Static build includes `collection-filters.js` and pre-computed data attributes
- [ ] Tests cover data-attribute rendering on all 3 page types, chip generation, toggle logic, URL fragment parsing
