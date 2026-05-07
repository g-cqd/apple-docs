# Icon Library UX Synthesis — apple-docs /symbols

Cross-site comparison of five reference sites and our current `/symbols` page. Screenshots in `docs/research/screenshots/icons/<site>/<browse|detail>-<width>.png`.

## Pattern matrix

| Feature | Material Symbols | Iconify | Lucide | Phosphor | Tabler | **Ours (local)** |
|---|---|---|---|---|---|---|
| Tile size mobile (360) | 52px label-wrapped | 48px label | 52px no label | 64px label | ~80px no label | ~96px label-wrapped |
| Tile size desktop (1440) | 64px label | 48px label | 56px no label | 80px label | 64px no label | ~70px label |
| Icons-per-row 1440 / 768 / 360 | 9 / 6 / 3 | 8 / 5 / 3 | 16 / 9 / 5 | 12 / 6 / 3 | 9 / 6 / 3 | **9 / ? / 3** |
| Search affordance | Top of grid, non-sticky | Top-right, route-jump | Sticky, top, Cmd-K | Sticky toolbar centre | Top of grid | Top of grid, non-sticky |
| Category filter (desktop) | Drawer toggle | Left sidebar checkboxes | Left sidebar single-select | none (text only) | Left sidebar single-select | **none** |
| Category filter (mobile) | Fullscreen drawer | Accordion | Accordion above grid | n/a | `<select>` dropdown | **none** |
| Detail container | Right inspector → bottom sheet | Dedicated route | Dedicated route | Per-tile floating popover | Inline expand-in-place | Right inspector → stacked panel |
| Customizer mobile placement | Bottom sheet | Form inline below preview | Card collapsed at top of route | Sticky toolbar (wrapped) | Inline panel above grid | **Stacked below grid** (panel) |
| Color picker UX | Swatch + dropdown | currentColor select | Swatch + hex input | Hex input only | Hex input | Native swatch + hex input |
| Size slider UX | Range slider w/ px readout | Preset dropdown | Range slider + label | Range slider w/ px readout | Range slider | Range slider + "Size 128px" label |
| Variable axis exposure | Full (Fill/Wght/Grad/Opsz) | none | Stroke width + absolute toggle | Weight (6 presets) | Stroke width | **none currently** |
| Download CTA | SVG + PNG + framework tabs | Copy x2 + Download | Copy SVG + Copy JSX | Copy/Download x4 in popover | Download SVG/PNG + Copy SVG/JSX | **Download SVG + Download PNG** |
| Empty / loading state | Skeleton spacers (virtualised) | "Narrow your search" >999 | Empty grid + zero-state copy | Hero pre-roll | Pagination footer always visible | Empty preview rectangle until selection |

## Top 5 patterns to copy

1. **Lucide's hover-tooltip-only labels.** Pure-icon tiles let the grid pack 16 cols at 1440 instead of 9. We pay readability cost only for users who *don't* hover, mitigated by the inspector/detail showing the full name. Frees vertical space we currently waste on truncated `text.below.recta…` strings.
2. **Phosphor's sticky global toolbar with live recolor.** A single sticky bar (search · weight · size · color) that drives the entire grid lets users *see their final styling everywhere before committing* — eliminates the "click then customize then back-out" loop. Implementable via CSS variables so no per-tile rerender.
3. **Lucide's dedicated detail route on mobile.** No bottom-sheet acrobatics; simple URL `/symbols/<name>` is shareable, back-button-friendly, and gives the customizer all the screen it needs.
4. **Material Symbols' variable-axis sliders with live readout.** "Weight 100 ↔ 700", "Optical Size 20px ↔ 48px" with the active value beside the slider. We have nothing here despite SF Symbols having weight/scale axes — easy win.
5. **Iconify's >999 truncation + "narrow your search" hint.** With 9,872 symbols, eagerly rendering everything kills first paint. Cap rendered tiles at ~600 with a "showing 600 of 9,872 — keep typing to refine" message; far cheaper than virtualisation.

## Top 3 anti-patterns to avoid

1. **Tabler's category-clears-search behaviour.** Filters must compose, not replace. Our search box already supports prefix matching; whatever taxonomy we add (categories, scope) must AND with the search query, not reset it.
2. **Iconify's form-style customizer on mobile.** Native `<select>` and checkboxes for size/color make the page feel like a 2010 settings dialog. Use sliders + swatches.
3. **Phosphor's hidden category model.** "Search-only" sounds clean but with 9,872 SF Symbols and a Apple-defined taxonomy (categories, scope), discarding facets is wasteful. Keep at least one taxonomy facet visible.

## Specific recommendations for `/symbols`

Mapped to mobile-first breakpoints. Current state: `9 cols at 1440, ~3 cols at 360, side-panel inspector, no categories, search non-sticky`.

- **360 (base):**
  - Drop tile labels; show name only in the inspector. Tile size 56px with 8px gap → 4 columns instead of 3.
  - Search bar `position: sticky; top: 0` with the scope `<select>` collapsed into a leading icon-button that opens a sheet with categories + scope.
  - Detail becomes a dedicated route `/symbols/<name>` — no stacked panel below the grid.
  - Download buttons in a sticky bottom bar within the detail route (thumb-zone reachable).
- **480:** Same as 360 but 5 columns. Sticky search bar grows to full width.
- **768:** 8 columns. Categories drawer opens from the left as an overlay; scope chip stays in the toolbar.
- **1024:** Switch to two-column layout: 220px category sidebar + grid (10 cols). Inspector replaces the right column when an icon is selected; otherwise the customizer occupies that column with "no icon selected" placeholder.
- **1440:** 12-column grid + 220px sidebar + 320px right inspector. Add variable-axis controls (weight, scale) when a symbol with axes is selected.
- **All breakpoints:**
  - Apply customizer values (size, color, background) to *all* visible tiles via CSS variables — Phosphor pattern. The inspector becomes an "edit globals + per-icon download" rather than "preview one icon."
  - Cap rendered tiles at 600, show "showing 600 of 9,872 — keep typing" hint until query length ≥ 2.
  - Use `content-visibility: auto` on each row (`<div role="row">`), `contain-intrinsic-size: 96px;` to skip off-screen layout for ~10x scroll improvement.
  - Composable filters: search AND scope AND category, never replace. Reflect state in URL (`?q=&scope=&cat=`) so back-button works.
