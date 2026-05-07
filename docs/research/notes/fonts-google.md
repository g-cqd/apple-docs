# Google Fonts — fonts.google.com

Captured 2026-05-06. Browse: `/`. Detail: `/specimen/Inter`.

## Browse page
- **Card grid:** Single-column (full-bleed) list at every breakpoint. Each row is one family; the sample text is rendered in the actual font at large size (~36-48 px). Cards are tall and atmospheric — density wins on legibility, not count. About 6 families per 1440x900 fold.
- **Per-card editability:** No. The sample text is global; cards are read-only previews.
- **Filter/search:** Persistent left rail at >=1024 px (Language, Writing system, Categories, Properties, Show only variable, etc.). Below 1024 px, the rail collapses into a `Filters` button at the top that opens a modal/drawer.
- **Sort + sample input:** A single sticky toolbar at the top of the list contains: Search box, "Sample type" preset dropdown (e.g. paragraph / sentence / alphabet / numerals), the *one* shared sample-text input, font-size slider, and Sort menu. Changing the sample text updates every card live.

## Family detail page anatomy
- **Header:** Family name, designer, About / License / Tags tabs, primary CTA `Get font` (top-right, persistent in mobile sticky header). `View selected families` slide-up appears as you accumulate selections (cart-like).
- **Customizer (left side, desktop):** A sidebar panel with switches: Variable Axes toggle, Optical Size toggle, Italic toggle, Weight slider (continuous because Inter is variable), preview-text-type dropdown (Writing system / Heading 1 / paragraph), font-size slider. Sliders are large with numeric readouts inline.
- **Variable axes:** Slider-per-axis with the axis name, current value, and min-max ticks. Clean, compact; lives in the same panel as Weight/Italic.
- **Italic toggle:** A standalone iOS-style switch labelled `Italic` — independent from the weight slider.
- **Weight switching:** Continuous slider when variable; discrete pill buttons (Light / Regular / Bold...) appear in the per-style "Styles" section further down.
- **Sample propagation:** The big preview block at the top of the detail is driven by the same input. Below it, a `Styles` table renders every static style with its own editable preview row — the user can override any single row's text inline.
- **Download CTA:** Single sticky `Get font` pill, top-right; secondary download appears in the bulk-selection sheet.

## Mobile transformation (360 px)
- The sidebar customizer collapses **inline** above the preview (no drawer). Order: sample text input -> writing-system + heading dropdowns -> variable axes / italic / weight rows -> alignment buttons -> the live preview. Sticky top-bar keeps `Get font` always visible.
- Sliders are full-width with ~44 px touch targets; switches are native iOS-style ~30x18 px.
- Filters on browse become a `Filters` button (no drawer; a chip popover) and a horizontal scrollable category strip (Fonts / Icons / Knowledge / FAQ).

## Time-on-task (cold load -> "Bold sample"):
1. Tap into family. 2. Edit sample text. 3. Drag weight slider to ~700.
**3 taps + 1 drag.** No mode switches, no italic accident.
