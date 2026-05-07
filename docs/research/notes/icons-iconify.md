# Iconify — icon-sets.iconify.design

Meta-browser of 200+ icon sets — primarily a counter-example: optimised for picking a *set*, not a single icon.

## Grid density
- 1440: 5 columns of "set cards", each card showing 8 sample icons + title + count. Not an icon-per-tile grid at the landing page.
- 1024: 4 columns. 768: 3 columns. 480/360: 1 column.
- Inside a set: the grid becomes 8 columns at 1440, 5 at 768, 3 at 360. Tiles ~48px with a small label below.

## Tile content
On the landing page each tile is a *set sample* (icon strip + name). Inside a set: pure icon glyph; the icon name appears as a tooltip and below the icon. No truncation at small viewports — names wrap to two lines.

## Search
Top-right input, full-width on mobile. Live filter against the icon name within the current set; from the landing page, search jumps you into a global "search results" route. Composes with set filters but discards category facets.

## Category filter
Set-level filter only — left sidebar on desktop with "Categories" (e.g. General, Brands, Maps, Emoji). Multi-select via checkboxes. Mobile collapses to an accordion above the grid.

## Detail
Dedicated route (`/<set>/<icon>/`) — full page, not a drawer. Layout: large preview top-left, customizer form right. Back link to set browser at top. No modal/sheet behaviour anywhere.

## Customizer
Form-style: size (preset dropdown, "auto/24px"), color (currentColor/picker), Add stroke checkbox, Prettify checkbox, Add empty rectangle checkbox. Tabs across the top toggle output format: SVG / Symbol / JSX.

## Download
Three inline CTAs: "Copy to Clipboard", "Copy to Clipboard as URL", "Download" (file). Sits below the live SVG snippet. No primary/secondary hierarchy — all three same weight.

## Performance
Light DOM. Results truncated to first 999 matches with explicit "narrow your search" message — the answer to "thousands of icons" is *don't render thousands of icons*. No virtualisation; pagination by category instead.

## Mobile-specific
No sticky CTAs. Detail page footer floats below the long form. The form-y customizer is awkward on small screens (dropdowns require tap-out-tap-in).
