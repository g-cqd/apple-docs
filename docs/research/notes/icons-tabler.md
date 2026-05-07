# Tabler — tabler.io/icons

Conservative, marketing-page-styled icon explorer. Useful for the inline-detail pattern.

## Grid density
- 1440: 9 columns of ~64px tiles inside a centre column with the left sidebar (~220px) + grid. Pagination "Page 1 of N" below the grid; no infinite scroll.
- 1024: 8 columns. 768: 6 columns. 480: 4 columns. 360: 3 columns.

## Tile content
Pure icon glyph, no name. Hover shows a tooltip with the icon name. Selection (after navigation) shows the icon detail panel above the grid with the tile remaining highlighted in place.

## Search
Top of the centre column, full-width-ish (~600px). Live filter. Resets pagination. Does not compose with category facets cleanly — selecting a category clears the search query.

## Category filter
Left sidebar on desktop, flat list of categories with counts ("Brand 200", "Buildings 14" …). Mobile (<768) collapses sidebar into a top "Categories" select dropdown — *not* a chip row, *not* a drawer.

## Detail
Dedicated route (`/icons/icon/<name>`) BUT renders inline above the grid as an expanded panel rather than replacing the page. Layout: large preview left + tabs (React / Vue / SVG / PNG) + axis controls right. Closing returns you to the same scroll position.

## Customizer
Inside the detail panel only, not a global sidebar. Exposes: stroke (1–2.5), size, color (hex). Toggle for filled vs outlined where applicable. Sliders are HTML range inputs — small touch targets.

## Download
Inside detail panel: "Download SVG", "Download PNG", "Copy SVG", "Copy JSX" as four buttons. Plus a code-snippet block with copy icon for each framework tab.

## Performance
Server-paginated grid (~108 icons per page). No virtualisation needed because the grid is bounded. Trade-off: users can't Ctrl-F the entire set, must rely on search.

## Mobile-specific
The inline detail panel pushes the grid down — feels like a non-modal "expand-in-place." No bottom sheet, no fullscreen route on mobile. CTAs sit mid-screen (not thumb-zone optimised). Categories collapse to a `<select>`, which is the simplest possible mobile-friendly answer.
