# Lucide — lucide.dev/icons

Cleanest, most opinionated mobile-first design of the five. Strong reference.

## Grid density
- 1440: 16 columns of 56px tiles, 4px gap, in a centre column. ~12 rows (~190 icons) above the fold.
- 1024: 12 columns.
- 768: 9 columns.
- 480: 6 columns.
- 360: 5 columns at ~52px. Search bar consumes the full top row.

## Tile content
Pure icon, no inline label. Hover reveals a small tooltip with the name. Selection adds a 2px ring. No truncation problem because no label is shown.

## Search
Sticky search bar at the top of the grid (desktop) and at the top of the mobile drawer. Live filter. Composes with the active category — you can search within "Buildings" without losing the facet. Cmd-K shortcut is exposed.

## Category filter
Left sidebar on desktop (>= 1024) — flat list of single-select category names with counts. Mobile collapses categories under a "Categories" accordion above the grid (single-select). "Include external libs" (Lab) is a checkbox toggle separate from categories.

## Detail
Dedicated route (`/icons/<name>`). Layout: left rail = customizer card (sticky); centre = giant icon preview + size/style variants strip + "Copy SVG / Copy JSX" buttons + framework code tabs; below = "See this icon in action" mockup gallery. On mobile (<768), the customizer becomes a collapsed card at the top of the route.

## Customizer
Sidebar card with: Color (swatch + hex), Stroke width slider (1–3px), Size slider (default 24, range 12–48), Absolute stroke width toggle. Live preview updates on change. Slider thumbs are large and touch-friendly.

## Download
Two pill buttons inline: "Copy SVG" (primary), "Copy JSX" (secondary). Framework tabs below show install + import code with a small copy icon. No "Download .svg" file CTA — clipboard-first.

## Performance
Per-tile uses inline `<svg>`. The full grid renders eagerly — ~1600 icons on page load — but the SVGs are tiny (single-path strokes), so paint stays under 100ms. No CSS containment hints visible. Filter is JS-driven, hides via `display:none`.

## Mobile-specific
Detail is a full route, not a sheet. CTAs (Copy SVG / Copy JSX) are inline at preview height — comfortable thumb zone if user scrolls slightly. No bottom sticky bar.
