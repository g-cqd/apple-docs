# Fontspring — fontspring.com

Captured 2026-05-06. Browse: `/tag/sans-serif` (the canonical category-listing pattern; `/fonts` and `/browse` are 404). Detail: `/fonts/exljbris/museo-sans`.

## Browse page
- **Card grid:** Single-column, very tall family rows. Each row shows the family name + foundry + style-count, an editable sample line rendered very large (the Aa-Zz string by default), with `From $X` or `1 font free!` price tag on the right. ~3 families per 1440 fold.
- **Per-card editability:** Effectively yes — the **single** "Type your text here..." input at the top of the page propagates to every row's sample line. (No per-row text override.)
- **Filter/search:** Persistent left rail >=1024 px with collapsible accordions: Sort By (Bestselling default, dropdown), Category (+), Sub Categories (+), Languages (+). Top-right of the listing carries a Font Size slider for the previews. Global Search box is in the top header.
- **Sort + sample input:** Sort = explicit `Sort By` dropdown above filters. Sample-text input is the *largest* element on the page — center, full-width, dropdown caret to load presets. Font-size slider on the right of the same row.

## Family detail page anatomy
- **Header:** Breadcrumb (Fonts / Sans Serif / Museo Sans), family name *huge* set in the actual font as a hero. To the top right: "10 fonts from $89.00", primary purple `Buy family` and secondary `Try` outline buttons.
- **Sticky right-rail TOC** ("Jump to: About this font family / Type tester / Licensing / Similar fonts / Buy Family") — anchored navigation rather than tabs.
- **Customizer:** Lives in the "Type tester" section further down (not above the fold). When reached, it offers a sample-text input, font size, and per-style row preview.
- **Variable axes:** Sparse on Fontspring; surfaced via a `Variable` tag filter on browse but not as sliders on detail.
- **Italic toggle / weight switching:** None global. Each style is a row in Type tester, similar to Adobe.
- **Sample propagation:** Type-tester input drives all style rows; no per-row override visible.
- **Buy CTA:** Two-button persistent header (`Buy family` / `Try`), plus a sticky bottom action strip on mobile (`Add to list • Try font • Buy Family`).

## Mobile transformation (360 px)
- Header collapses to logo + cart + hamburger; "Discover Fonts" / "Licensing" remain inline below as horizontally-scrolling buttons.
- Filters on browse collapse behind a centered `Filters` pill at the bottom of the sample-text block — opens a full-screen drawer/sheet (not previewable in static capture).
- Detail page hero stays huge ("Museo Sans" word fills most of viewport width); the sticky bottom bar shows "Add to list • Try font • Buy Family" — the **only** marketplace in this set with a persistent bottom action bar on mobile.

## Time-on-task (cold load -> "Bold sample with my text"):
On browse: 1. Tap input. 2. Type. (See families propagated.) 3. Tap a family row.
On detail: 4. Scroll to Type tester. 5. Find Bold row.
**3 taps + 1 long scroll.** Can also click into a specific weight from a tag filter on browse to short-circuit.
