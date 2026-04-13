# Phase 10-B: Page Section Navigation (Table of Contents)

> **Goal**: Add an in-page table of contents to document pages so users can see all sections at a glance and jump to any section instantly, especially on long API reference pages with declaration, discussion, topics, relationships, and see-also sections.

## Motivation

Many document pages — particularly API symbol pages — contain 5-8 distinct sections that can span many screen-lengths. Currently the only way to navigate is scrolling. Apple's own developer documentation and most documentation sites provide a section TOC for quick navigation.

| Scenario | Today | Target |
|---|---|---|
| "Jump to Topics on a long class page" | Scroll down past declaration, parameters, discussion | Click "Topics" in TOC sidebar |
| "See what sections a page has" | Scroll to discover | Glance at TOC on page load |
| "Jump to See Also" | Ctrl-F or scroll to bottom | Click "See Also" in TOC |
| "Know where I am on a long page" | No indicator | Active section highlighted in TOC |
| "Navigate on mobile" | Same scrolling | Collapsible TOC disclosure at top of article |

## Architecture

### Section anchors

The HTML renderer (`renderHtml` via `renderSectionHtml`) produces `<section>` blocks with `<h2>` headings for each section kind. Currently these sections have no `id` attributes, so there's nothing to link to.

**Change**: Add `id` attributes to each `<section>` based on the section kind or heading:

| Section Kind | Anchor ID | Display in TOC |
|---|---|---|
| `abstract` | (no anchor — always visible at top) | — |
| `declaration` | `#declaration` | Declaration |
| `parameters` | `#parameters` | Parameters |
| `discussion` | `#discussion` or `#overview` | Overview / Discussion |
| `topics` | `#topics` | Topics |
| `relationships` | `#relationships` | Relationships |
| `see_also` | `#see-also` | See Also |
| Custom heading | `#${slugify(heading)}` | Heading text |

### TOC generation

The TOC is generated **server-side** during template rendering (not client-side), because the sections are already known at render time. This ensures:

- TOC works in static builds without JS
- No flash of empty TOC on page load
- SEO-friendly anchored headings

**`buildPageToc(sections)`** in `templates.js`:
1. Iterate over sections, skip `abstract` (always at top)
2. For each section with a heading, emit a `<li><a href="#anchor">Heading</a></li>`
3. Wrap in `<nav class="page-toc" aria-label="On this page">`

### Layout integration

The document page already supports a sidebar layout via `.has-sidebar` CSS grid (1fr + 260px). Currently the sidebar is used exclusively for the relationships section rendered as `<aside class="doc-sidebar">`.

**New layout strategy**:

- The TOC becomes part of the sidebar column
- On pages **with** a relationship sidebar: TOC appears above relationships in the same sidebar
- On pages **without** a relationship sidebar: TOC is the sidebar (page gains `.has-sidebar` class)
- The sidebar content (TOC + optional relationships) scrolls with the page but the TOC portion is `position: sticky`

**Desktop (>= 1024px)**:
```
┌──────────────────────────────────────────────────────┐
│  [site-name]        [ Search… ]               [🌗]  │
├──────────────────────────────────────────────────────┤
│  breadcrumbs                                         │
│  badges                                              │
├──────────────────────────┬───────────────────────────┤
│                          │  On this page             │
│  # NavigationStack       │  ├─ Declaration           │
│                          │  ├─ Overview              │
│  <abstract>              │  ├─ Topics                │
│                          │  ├─ Relationships         │
│  ## Declaration          │  └─ See Also              │
│  ```swift                │                           │
│  struct NavigationStack  │  ─────────────────        │
│  ```                     │  Relationships            │
│                          │  Conforms To              │
│  ## Overview             │  ├─ View                  │
│  A view that displays…   │  └─ Sendable              │
│                          │                           │
│  ## Topics               │                           │
│  ### Creating a Stack    │                           │
│  - init(path:root:)      │                           │
│  ...                     │                           │
├──────────────────────────┴───────────────────────────┤
│  Built on 2026-04-13                                 │
└──────────────────────────────────────────────────────┘
```

**Mobile (< 1024px)**:
```
┌──────────────────────────────┐
│  [site-name]  [Search] [🌗] │
├──────────────────────────────┤
│  breadcrumbs                 │
│  badges                      │
│                              │
│  ▶ On this page              │  ← collapsible <details>
│                              │
│  # NavigationStack           │
│  ...                         │
└──────────────────────────────┘
```

### Scroll tracking

A small JS module uses `IntersectionObserver` to track which section is currently in view and highlight the corresponding TOC link. This is progressive enhancement — the TOC works without JS (plain anchor links).

## Tasks

| ID | Task | Depends | Files |
|---|---|---|---|
| 10B.1 | Add `id` attributes to `<section>` elements in `renderSectionHtml` | — | `src/content/render-html.js` |
| 10B.2 | Add `buildPageToc(sections)` helper in templates.js | 10B.1 | `src/web/templates.js` |
| 10B.3 | Integrate TOC into `renderDocumentPage` — all document pages gain sidebar with TOC; relationship sidebar content moves below TOC | 10B.2 | `src/web/templates.js` |
| 10B.4 | Refactor `.has-sidebar` logic — all pages with >= 2 sections get sidebar (not just pages with relationships) | 10B.3 | `src/web/templates.js` |
| 10B.5 | Add TOC CSS: sticky positioning, active state, mobile `<details>` collapse, smooth transitions | 10B.3 | `src/web/assets/style.css` |
| 10B.6 | Build `page-toc.js` — IntersectionObserver scroll tracking, active link highlighting, smooth scroll | 10B.5 | `src/web/assets/page-toc.js` |
| 10B.7 | Wire `page-toc.js` into document page `<script>` tags | 10B.6 | `src/web/templates.js` |
| 10B.8 | Copy `page-toc.js` in static build asset pipeline | 10B.6 | `src/web/build.js` |
| 10B.9 | Tests: section anchor IDs, TOC generation from sections, sidebar layout logic, scroll tracking | 10B.1-8 | `test/unit/web-templates.test.js`, `test/unit/render-html.test.js` |

## Key decisions

| # | Decision | Rationale |
|---|---|---|
| D-01 | Server-side TOC generation | Works in static builds, no JS required for basic functionality, no layout shift |
| D-02 | TOC integrated into existing sidebar column | Reuses the `.has-sidebar` grid layout; avoids a third column or layout redesign |
| D-03 | All document pages with 2+ sections get a sidebar | Previously only pages with relationships had a sidebar; TOC is useful on any multi-section page |
| D-04 | `<details>` on mobile | Native collapsible, no JS required, accessible by default |
| D-05 | IntersectionObserver for scroll tracking | Performant, no scroll event listener spam, graceful degradation |
| D-06 | Section IDs derived from `sectionKind` + heading | Stable anchors — `#declaration`, `#topics` etc. are predictable and bookmarkable |
| D-07 | Skip abstract in TOC | Abstract is always the first visible content — linking to it adds no value |

## Exit criteria

- [ ] Every `<section>` in rendered document pages has a stable `id` attribute
- [ ] Document pages with 2+ sections show a TOC sidebar on desktop
- [ ] TOC links scroll to the correct section via anchor navigation
- [ ] Current section is highlighted in the TOC as the user scrolls (JS enhancement)
- [ ] Relationship sidebar content appears below the TOC in the same sidebar column
- [ ] Mobile layout shows the TOC as a collapsible `<details>` element above the article
- [ ] Static build includes `page-toc.js` and all section IDs are present in generated HTML
- [ ] TOC works without JavaScript (plain anchor links)
- [ ] Tests cover section ID generation, TOC rendering, sidebar layout conditions
