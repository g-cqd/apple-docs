# Phosphor — phosphoricons.com

Single-page-app feel: hero, then one persistent sticky toolbar over an infinite grid. The most "designerly" of the five.

## Grid density
- 1440: ~12 columns of 80px tiles with generous 16px gap. Hero pushes the grid below the fold initially, then the toolbar sticks once scrolled.
- 1024: 8 columns. 768: 6 columns. 480: 4 columns. 360: 3 columns at ~64px.

## Tile content
Icon glyph + name below in small caps-style label. Hover swaps the tile background to a beige tint. Long names truncate with ellipsis on small viewports. Click selects in place.

## Search
Centre of the sticky toolbar — full-width on mobile, ~280px on desktop. Live filter. Composes with the weight selector (Regular/Thin/Light/Bold/Fill/Duotone) which sits to its left.

## Category filter
None visible. Phosphor relies entirely on text search + icon weight as facets. (No taxonomy concept on the public site.)

## Detail
No detail route, no modal. Selecting an icon does NOT navigate — instead the sticky toolbar's controls (color, size, weight) apply globally to all rendered tiles, and clicking an icon opens a small floating popover with copy/download buttons next to the tile. Effectively "the whole grid is the customizer."

## Customizer
Lives inside the sticky top toolbar: weight dropdown · search · size slider (with px readout) · color hex input · 4 inline action icons (copy SVG, copy JSX, download SVG, download PNG). Single horizontal row; on mobile it wraps onto two rows.

## Download
Per-icon popover offers: Copy SVG, Copy PNG, Copy JSX, Download SVG, Download PNG. Bulk-style "apply to all" via the toolbar (e.g. set color to red and the whole grid recolors).

## Performance
~1500 icons rendered as inline SVGs. Smooth thanks to CSS `content-visibility: auto` on tile rows (visible in computed styles) — off-screen rows skip layout/paint. Recolor cascades via CSS variables, not per-element re-render.

## Mobile-specific
Sticky toolbar wraps to two rows; size slider becomes full-width which feels good for thumb adjustment. Per-tile popover anchors above the icon and doesn't push layout — uses `position: fixed`.
