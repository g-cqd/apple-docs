# Material Symbols — fonts.google.com/icons

Closest functional analog to our /symbols page: also a sealed catalog with a customizer. Captured at 1440 / 1024 / 768 / 480 / 360.

## Grid density
- 1440: 9 columns of ~64px tiles inside a centre column (~880px wide), gap ~16px. ~6 rows (~54 icons) above the fold; the page lazy-appends as you scroll, producing the very long full-page screenshots.
- 1024: 8 columns, similar tile size.
- 768: 6 columns, sidebar collapses.
- 480: 4 columns. 360: 3 columns. Tiles shrink to ~52px and labels truncate to single line with ellipsis.

## Tile content
Icon + name underneath, two-line wrapped (e.g. "Home App Logo"). Selection state is a thin blue outline around the active tile. No hover popup — the inspector panel is the source of truth.

## Search
Top-of-grid input (not sidebar). Live filter, debounced. A separate "Filters" chip clears category facets but composes with the search query. On scroll the search bar does NOT stick — you must scroll back up.

## Category filter
Dedicated "Filters" drawer (toggle in toolbar). On desktop opens as a sheet over the centre column; on mobile opens as a fullscreen drawer. Multi-select with chips.

## Detail
Right-hand inspector panel, ~320px wide, sticky. On mobile (<= 768) it transitions to a bottom sheet that pushes/overlays the grid.

## Customizer
Left rail, persistent. Exposes the full variable axes: FILL toggle (switch), Weight slider (100–700), Grade slider (-25 to 200), Optical Size slider (20px–48px). Style picker (Outlined / Rounded / Sharp) is a select. Color picker NOT exposed in the customizer — sits inside the inspector instead.

## Download
Right inspector exposes "SVG" and "PNG" buttons side by side (primary blue), plus framework tabs (Web / Android / Apple) for code snippets. Copy-to-clipboard via icon button next to each snippet.

## Performance
Massive virtualisation/windowing: only ~10 rows actually rendered; the full-page screenshot has huge blank space because the placeholder spacer extends downward. Tiles are font glyphs (variable font), not SVG, so the entire grid is one font draw — extremely fast even at 3000+ icons.

## Mobile-specific
Filter drawer is fullscreen with a sticky "Apply" CTA in the thumb zone. Detail is a bottom sheet covering ~70% of the viewport with the grid still scrollable behind it.
