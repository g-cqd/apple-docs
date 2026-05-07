# /fonts and /symbols — UX synthesis (P6)

Bridge document between research (P2–P4) and implementation (P7).
Self-contained — implementer should not need to re-read upstream notes.
Citations point back at `tmp/prod-probe-findings.md`, the per-site notes
in `docs/research/notes/`, and the screenshot trees under
`docs/research/screenshots/{prod,local,fonts,icons}/`.

---

## 1. TL;DR

- **Mobile header is broken below ~485px on prod and local.** P0 for
  P7 — collapse `.theme-switcher` below `30em`, reflow
  `.search-container` to a second row, kill horizontal scroll at
  360/480.
- **/symbols**: Phosphor-style global toolbar + Lucide-style
  label-less tile grid. 5 cols at 360, ~12 cols at 1440. Customizer
  recolors every visible tile via CSS variables. Detail becomes a
  dedicated route `/symbols/<name>` on mobile, an inspector drawer on
  desktop.
- **/fonts**: one global free-text sample input (Google + Fontspring),
  single-column tall-row family list at every width, stacked inline
  customizer above the styles list. No drawers, no modals, no carousels.
- **Variable axes are exposed.** Material Symbols pattern for /symbols
  (Weight, Scale with numeric readouts); Google Fonts pattern for /fonts
  (per-axis sliders co-located with weight + italic). Italic is always
  a separate iOS-style switch.
- **Done means**: explicit checks at 360/480/768/1024/1440 (§9), no
  horizontal scroll at any width, primary CTA in ≤2 taps from cold-load
  on 360.
- **Two ops fixes go on the P7 ledger as a runbook item, not source**:
  rebuild prod symbol cache (half-scale viewBox, ~9% stale) and audit
  `dist/web/assets/fonts/*` on mm18 for the stuck `@font-face` URL.

---

## 2. Production findings (P2)

Source: `tmp/prod-probe-findings.md`, screenshots at
`docs/research/screenshots/{prod,local}/{symbols,fonts}-{w}x{h}.png`.
Five issues, ranked.

| # | Finding | Source | Severity | Owner |
|---|---|---|---|---|
| 1 | **Header overflow ≤480px.** `.theme-switcher` (3×30px) sits next to `.search-container`; combined right edge = 485px, so 360 and 480 both report `scrollWidth=485`. Identical on prod and local. Forces horizontal scroll on every phone. | source-side CSS | P0 | `templates.js` + `serve.js` |
| 2 | **`document.fonts.ready` never resolves on prod /fonts.** 171 `@font-face` rules inject and content paints, but ≥1 URL stays in `loading` indefinitely. Local resolves promptly. FontFaceSet-tied behaviours (LCP, `font-display` swaps, headless screenshots) hang. | deploy-side | P1 | Ops — audit `dist/web/assets/fonts/*` on mm18 |
| 3 | **Prod symbol DB ~9% behind.** Prod shows "8 954 symbols", local "9 872". 918 missing symbols, search misses them. | deploy-side | P1 | Ops — `apple-docs symbols ingest` on mm18 |
| 4 | **Prod renderer cache emits half-scale viewBox.** Pencil: prod `0 0 226.1 224.85`, local `0 0 452.2 449.7`. Same 2× ratio across heart, star, gear, trash, plus, arrow.right. Visually OK due to explicit `width`/`height` attrs, but downstream embeds that drop those attrs get half-size geometry. | deploy-side | P1 | Ops — `apple-docs symbols render --reset-cache` |
| 5 | **Search input doesn't reflow below 480px.** Shrinks to ~46px wide instead of moving to row 2. Compounds #1. | source-side CSS | P0 | `templates.js` + `serve.js` |

Bugs #1 and #5 are P7's CSS job. #2–#4 are an mm18 runbook task (P7
ledger entry, not P7 code). Renderer family is identical between prod
and local — no source-side SVG bug. Console clean, network clean.

---

## 3. Font UX patterns (P3 distilled)

| Pattern | Google | Adobe | MyFonts | Fontspring | Monotype | **Ours (target)** |
|---|---|---|---|---|---|---|
| **Sample-text scope** | global free, browse+detail, per-row override on detail | preset only on browse; free via "Edit" on detail; per-row preview, no override | none on browse, single global on detail | global free on browse (hero element); single in "Type tester" on detail | none | **global free, top-of-page, drives every preview** (Google + Fontspring) |
| **Weight selector** | slider when variable + per-style pills | none — flat row list | none — flat list | none — flat list | n/a | **slider when variable; pills if static** |
| **Italic toggle** | standalone iOS switch | none — separate rows | none | none | n/a | **standalone iOS switch** (Google) |
| **Variable axes** | per-axis slider, label + numeric, co-located w/ weight | inline when supported | not surfaced | tag filter only | n/a | **per-axis slider, label + numeric** (Google) |
| **Filter ergonomics** | rail ≥1024 → chip popover + horizontal category strip on mobile | rail ≥1024 w/ **visual tag chips** → "Show Filters" sheet | mega-menu + global search | accordion rail → full-screen sheet on mobile | none | **rail ≥1024 + chip strip on mobile, visual tag chips** (Google + Adobe) |
| **Mobile filter container** | chip popover, no drawer | full modal sheet | hamburger only | full-screen sheet | n/a | **chip strip + popover, no full drawer** |
| **Mobile customizer container** | inline accordion above preview | inline above style list | inline strip above list | inline in "Type tester" + sticky bottom bar | n/a | **inline above style list, no drawer** |
| **Sticky elements** | header + `Get font` CTA on mobile | header + help bubble | top promo banner | header + bottom action bar on mobile | header + `Book a demo` | **header (family + CTA), no promo banners** |
| **Card density (1440)** | 1 col, ~6/fold | 3 col, ~9/fold posters | carousel 4-up + grids | 1 col, ~3/fold huge | none | **1 col tall-row, ~6/fold** (Google) |
| **Download CTA placement** | sticky `Get font` pill top-right | `Add family` top-right + per-row `Add font` | tiered pricing + `Buying Choices` | `Buy family` top-right + **sticky bottom bar on mobile** | `Purchase options` ghost | **top-right desktop; sticky bottom bar on mobile** (Fontspring) |

Sources: `docs/research/notes/fonts-{google,adobe,myfonts,fontspring,monotype}.md`,
screenshots `docs/research/screenshots/fonts/<site>/`. Where per-site
contradicts `fonts-synthesis.md`, per-site wins.

---

## 4. Icon UX patterns (P4 distilled)

| Pattern | Material | Iconify | Lucide | Phosphor | Tabler | **Ours (current)** | **Ours (target)** |
|---|---|---|---|---|---|---|---|
| **Tile px 360 / 768 / 1440** | 52 / ~58 / 64 | 48 / inset / 48 | 52 / ~56 / 56 | 64 / ~72 / 80 | ~52 / 56 / 64 | ~96 wrap / ? / ~70 | **52 / 60 / 64** |
| **Cols 360 / 768 / 1440** | 4 / 6 / 9 | 3 / 5 / 8 | **5 / 9 / 16** | 3 / 6 / 12 | 3 / 6 / 9 | 3 / ? / 9 | **5 / 8 / 12** |
| **Label or hover-only** | label, 2-line wrap | label, 2-line wrap | **hover only** | label below (small caps) | **hover only** | label, wraps/ellipsis | **hover/focus tooltip only** (Lucide + Tabler) |
| **Search affordance** | top, **non-sticky** | top-right, route-jump | **sticky + Cmd-K** | sticky toolbar centre | top of column | top, non-sticky | **sticky toolbar at top of grid** (Lucide + Phosphor) |
| **Category facet** | "Filters" drawer (multi) | left rail checkboxes (multi) | left rail single-select w/ counts | **none — search only** | left rail single-select w/ counts | none | **single-select rail ≥1024; `<select>` <768** (Tabler + Lucide) |
| **Detail container** | right inspector → bottom sheet ≤768 | dedicated route | **dedicated route** | per-tile popover | expand-in-place (anti) | inspector → stacked panel | **route on mobile (Lucide); inspector drawer on desktop (Material)** |
| **Customizer scope** | global left rail | per-icon on detail route | per-icon sidebar card | **global sticky toolbar (CSS vars)** | per-icon expand-in-place | per-icon stacked below | **global sticky toolbar via CSS vars** (Phosphor) |
| **Color picker** | in inspector only | currentColor select | swatch + hex | **hex only** | hex | native swatch + hex | **native swatch + hex** |
| **Size slider** | range + px readout | preset dropdown (anti) | range + label | **range + px readout** | range | range + label | **range + inline px readout** |
| **Variable axis exposure** | **full: Fill, Wght 100-700, Grad, OpSz** | none | stroke 1-3 + absolute | weight (6 presets) | stroke | none | **Weight + Scale w/ readout** (Material) |
| **Download CTA** | SVG + PNG + framework tabs | Copy×2 + Download (flat) | Copy SVG + Copy JSX | Copy/Download ×4 in popover | Dl SVG/PNG + Copy SVG/JSX | Dl SVG + Dl PNG | **Copy SVG primary, Dl SVG secondary, Dl PNG + framework tabs** |

Sources: `docs/research/notes/icons-{material-symbols,iconify,lucide,phosphor,tabler}.md`,
screenshots `docs/research/screenshots/icons/<site>/`. `icons-synthesis.md`
suggests 4 cols at 360 with 56px tiles; Lucide's per-site note says 5
cols at 52px. We adopt **5 cols at 52px** — densest in the set,
evidence-backed.

---

## 5. Recommendations for /fonts

Each recommendation cites the competitor pattern it copies and the
file it lands in.

### 5.1 Header
Logo + page title + global search left, primary CTA right. Sticky on
scroll. Below 480px, `.theme-switcher` collapses behind the menu or
hides; search reflows to row 2, full-width. Fixes P2 #1 and #5.
→ `src/web/templates.js` head + `src/web/serve.js` synthesised CSS.

### 5.2 Family card
Single-column tall-row layout at every viewport. Each row: family
name + designer/foundry on the left, large in-family sample text on
the right (or full-width below at <768), style-count badge. → Google
(`fonts-google.md`, ~6/fold at 1440) + Fontspring tall-row variant
(`fonts-fontspring.md`). Avoid Adobe's three-column poster grid
(`fonts-adobe.md` — wastes vertical, breaks editable-sample model).

### 5.3 Family detail
- **Hero**: family name large, set in the actual font (Fontspring,
  `fonts-fontspring.md`). Designer line, tag chips, primary CTA
  top-right.
- **Customizer**: stacked inline above the styles list — no drawer
  at any viewport. Order: sample input → font-size → weight (slider
  or pills) → italic switch → variable-axis sliders. (Google,
  `fonts-google.md`.)
- **Styles list**: per-row preview of global sample text in that
  cut, with click-to-edit inline override per row (Google's "Styles
  table", `fonts-google.md`).
- **No tabs.** Anchored right-rail TOC at ≥1024 (Type tester / About
  / Licensing — Fontspring, `fonts-fontspring.md`).
- → `src/web/templates.js` + `src/web/assets/fonts-page.js`.

### 5.4 Customizer (sample text, weight, italic, axes)
- One sample-text `<input>` at top of every page, free text, default
  *"Reading Apple docs in good type."*. Wired via CSS custom prop
  `--sample-text` consumed by every preview — no per-element
  re-render. (Google + Fontspring.)
- **Weight**: continuous slider for variable, discrete pills
  (Light/Regular/Medium/Bold/Heavy) for static. Numeric readout inline.
- **Italic**: standalone iOS-style switch, never combined with
  weight. (`fonts-google.md`.)
- **Variable axes**: one slider per axis (`wght`, `opsz`, `GRAD`)
  with label + numeric readout, same panel as weight + italic.
  (`fonts-google.md`.)
- Touch targets ≥44px on every slider thumb and switch.

### 5.5 Filter rail
- **Desktop (≥1024)**: persistent left rail with collapsible
  accordions (Category, Tag, Properties, Variable-only). → Fontspring
  + Google + Adobe.
- **Tags rendered in their own visual style** ("Calligraphic" set in
  a calligraphic face, etc.). Adobe (`fonts-adobe.md`). Cheap CSS win.
- **Mobile (<1024)**: horizontal-scroll category strip under the
  search bar (Google's `fonts-google.md`) + `Filters` button opens a
  chip popover, NOT a full-screen drawer. Avoid Adobe/Fontspring's
  full-screen modal — over-large affordance for our thin taxonomy.

### 5.6 Download CTA
- **Desktop**: single sticky `Copy CSS` / `Get font` pill, top-right.
  (Google + Adobe.)
- **Mobile**: persistent **bottom** action bar with the same primary
  CTA. (Fontspring, `fonts-fontspring.md` — better thumb reach than
  sticky-top.)
- **Per-style row**: secondary `Copy <style>` action icon at row
  end. (Adobe per-row pattern, `fonts-adobe.md`.)

---

## 6. Recommendations for /symbols

### 6.1 Header
Same fix as /fonts § 5.1 (single shared component). Page title
`SF Symbols` + symbol count + global search. Sticky on scroll.

### 6.2 Tile grid
`grid-template-columns: repeat(auto-fill, minmax(<min>, 1fr))`. Min
values target the column counts in §4.

| Viewport | Min tile | Cols | Gap |
|---|---|---|---|
| 360 | `52px` | 5 | 8px |
| 480 | `56px` | 6 | 8px |
| 768 | `60px` | 8–9 | 12px |
| 1024 | `60px` (+ 220px sidebar) | 10 | 12px |
| 1440 | `64px` (+ 220px sidebar + 320px inspector) | 12 | 16px |

→ Lucide pattern (`icons-lucide.md`, 16 cols at 1440 in centre
column) scaled for our sidebar + inspector columns.

### 6.3 Tile content
- **No always-on label.** Pure glyph. Hover reveals name in tooltip
  on desktop; `:focus-within` reveals on touch, dismisses on outside
  tap. → Lucide + Tabler (`icons-lucide.md`, `icons-tabler.md`); top
  pattern in `icons-synthesis.md`.
- **Selection**: 2px ring (Lucide).
- **`content-visibility: auto`** on each row with
  `contain-intrinsic-size: 96px`. → Phosphor (`icons-phosphor.md`).

### 6.4 Search/filter
- **Search**: `position: sticky; top: 0` at top of grid column. Live
  filter debounced ~80ms, AND-composes with active category, Cmd-K
  shortcut. (Lucide, `icons-lucide.md`.)
- **Cap rendered tiles at 600** with "showing 600 of 9 872 — keep
  typing" hint until query length ≥ 2. (Iconify, `icons-iconify.md`;
  cheaper than virtualisation.)
- **Category facet** (single-select): left sidebar ≥1024 with counts;
  native `<select>` <768. (Tabler `icons-tabler.md` + Lucide
  `icons-lucide.md`.)
- **Composable**: search AND scope AND category. URL state
  `?q=&scope=&cat=` for back-button. → Avoid Tabler's
  category-clears-search (`icons-tabler.md`, `icons-synthesis.md` AP#1).

### 6.5 Detail container
- **Mobile (<1024)**: dedicated route `/symbols/<name>`. Tap
  navigates — no drawer, no expand-in-place. Back button restores
  scroll. (Lucide, `icons-lucide.md`; `icons-synthesis.md` pattern #3.)
- **Desktop (≥1024)**: sticky right-rail inspector ~320px. When no
  tile selected, hosts the customizer with placeholder. (Material
  Symbols, `icons-material-symbols.md`.)
- Avoid Tabler's expand-in-place pushing customizer below the fold
  (`icons-tabler.md`); avoid Phosphor's popover-only model — breaks
  deep-linking we need.

### 6.6 Customizer (global)
- **Global sticky toolbar** (Phosphor, `icons-phosphor.md`): search ·
  category · weight · scale · color swatch · size. Values apply to
  every visible tile via CSS custom props (`--symbol-color`,
  `--symbol-size`, `--symbol-weight`, `--symbol-scale`). No per-tile
  re-render.
- Detail route inspector exposes the same controls plus per-icon
  Copy / Download.
- Avoid per-icon-only customization (Iconify/Tabler) —
  `icons-synthesis.md` pattern #2.

### 6.7 Variable axes
- SF Symbols axes: Weight (ultralight→black, 6 named pills) and
  Scale (small/medium/large 3-pill segmented; discrete in SF
  Symbols).
- For symbols supporting `monochrome|hierarchical|palette|multicolor`,
  surface a 4-way segmented control in the inspector only (most
  symbols are monochrome).
- Active value displayed inline ("Weight: Bold"). Material Symbols
  pattern (`icons-material-symbols.md`; `icons-synthesis.md` #4).

### 6.8 Download CTA
- Inspector (desktop) + detail route (mobile): primary `Copy SVG`
  (clipboard), secondary `Download SVG`, tertiary `Download PNG` +
  framework tabs (Web/SwiftUI/UIKit). (Material Symbols + Lucide
  hybrid.)
- Mobile: download CTAs in a sticky bottom action bar on the detail
  route. Mirrors Fontspring bottom-bar pattern from /fonts.

---

## 7. Mobile-first responsive breakpoints

| Width | /fonts | /symbols |
|---|---|---|
| **360** | Single-column family rows. Sample input full-width below header. Filter chip strip horizontal-scroll. Customizer stacked inline above styles list. Sticky bottom CTA bar. | 5-col grid, 52px tiles, 8px gap. Sticky search. Category as `<select>`. Tap tile → navigates to `/symbols/<name>`. Detail route has sticky bottom bar (Copy SVG). |
| **480** | Same single-column rows. Header fits cleanly. | 6-col grid, 56px tiles. Sticky bottom bar in detail route. |
| **768** | Single-column rows still. Filter chip strip + `Filters` popover. Header desktop-style. | 8–9-col grid, 60px tiles, 12px gap. Categories still `<select>`. Detail still a route. |
| **1024** | Persistent left filter rail. Customizer stays stacked inline above styles list (Google keeps inline even on desktop). Primary CTA top-right. Anchored right-rail TOC on detail. | Two-column shell: 220px sidebar + 10-col grid. Inspector replaces right column on selection; otherwise hosts the global customizer. Detail is the inspector, not a route. |
| **1440** | Left rail + content + optional right anchored TOC. ~6 family rows/fold. | Three-column: 220px sidebar + 12-col grid + 320px inspector. Variable axes appear when applicable. |

### Container queries vs media queries
- **Media queries** for the page shell (header, sidebar presence,
  route-vs-inspector decision). Pivot on viewport.
- **Container queries** for: (a) tile-grid column count inside the
  symbols centre column (its width changes when inspector opens
  independent of viewport); (b) family card's row internal layout
  (changes when filter rail toggles); (c) customizer slider stacking
  in detail content area.
- The `auto-fill, minmax()` recipe in §6.2 is itself container-aware
  — preferred over hard breakpoints for the symbol grid.

---

## 8. Anti-patterns to avoid

- **No live tester on a font product page** (Monotype,
  `fonts-monotype.md`). Always ship at least a sample-text input +
  per-style preview on the family page.
- **Promotional banners over function** (MyFonts sticky 30%-off
  banner pushes customizer below the fold, `fonts-myfonts.md`). For us
  this means no "What's new in iOS 18" / build-status banner above
  search/customizer.
- **Preset-only sample text** (Adobe browse, `fonts-adobe.md`).
  Always free-text by default.
- **Always-on labels under tiles** (Material Symbols, Iconify,
  Phosphor — wrecks density, e.g. 9 cols vs Lucide's 16 at 1440;
  ellipsis truncation is uglier than no label;
  `screenshots/local/symbols-1440x900.png` shows the same problem
  on us). Hover/focus tooltip only.
- **Expand-in-place detail panel** (Tabler `icons-tabler.md` + our
  current local) — pushes customizer below the fold. Use a route on
  mobile, inspector drawer on desktop.
- **Category-clears-search** (Tabler, `icons-tabler.md`). Filters
  must AND, never replace.
- **Form-style customizers on mobile** (Iconify `<select>` +
  checkboxes, `icons-iconify.md`). Use sliders + swatches with ≥44px
  touch targets.
- **Carousels on browse** (MyFonts, `fonts-myfonts.md`). Hide content,
  add JS weight, non-deterministic in screenshots.
- **Flat 100+ row style lists with no filter** (MyFonts/Fontspring
  detail). Use a weight slider + italic switch.

---

## 9. Acceptance checklist for P7

Concrete, testable. Run probes on both prod and local where possible.

### Shared header (both pages)
- [ ] **360 / 480**: `document.body.scrollWidth === viewport.width`.
      No horizontal scroll. (Currently 485 at both; P2 #1.)
- [ ] **360**: `.theme-switcher` hidden or collapsed into the
      hamburger.
- [ ] **360**: `.search-container` full-width on row 2, not 46px-shrunk
      (P2 #5).
- [ ] **480**: header fits on one row OR cleanly reflows to two
      rows, no overflow.
- [ ] **768 / 1024 / 1440**: header one row, sticky, primary CTA
      always visible.

### /fonts
- [ ] **360**: cold-load → tap family → drag weight to ~700 → see
      Bold sample. ≤2 taps + 1 drag. (Google time-on-task,
      `fonts-google.md`.)
- [ ] **360**: sample-text input at top of page, full-width, free
      text, ≥44px tall.
- [ ] **360**: primary CTA (`Copy CSS` / `Get font`) in a sticky
      bottom bar.
- [ ] **480 / 768**: sample input still top-of-page, no preset gate.
- [ ] **1024**: left filter rail visible; customizer stacked inline
      above styles list (NOT moved to a side rail).
- [ ] **1024+**: tag chips render in their tag's visual style.
- [ ] **1440**: ~6 family rows/fold; no carousel; no 3-col poster grid.
- [ ] **All widths**: italic is a separate switch, never folded
      into the weight axis.
- [ ] **All widths**: variable axes are sliders in the same panel
      as weight/italic, label + numeric readout.
- [ ] **All widths**: per-style rows support inline-edit override.

### /symbols
- [ ] **360**: 5 cols × 52px tiles × 8px gap.
- [ ] **360**: tap tile → URL becomes `/symbols/<name>` (route, not
      drawer / not expand-in-place).
- [ ] **360**: detail route has primary `Copy SVG` in a sticky
      bottom bar.
- [ ] **360 / 480**: search bar `position: sticky; top: 0`, visible
      on scroll.
- [ ] **480**: 6 cols × 56px tiles.
- [ ] **768**: 8–9 cols × 60px tiles; categories via `<select>`.
- [ ] **1024**: 220px sidebar + 10-col grid; inspector appears in
      right column on selection.
- [ ] **1440**: 220px sidebar + 12-col grid + 320px inspector;
      variable axes (Weight, Scale) appear when applicable.
- [ ] **All widths**: tiles have NO always-on label; hover/focus
      reveals name in tooltip.
- [ ] **All widths**: changing color in the global toolbar recolors
      every visible tile via CSS vars (no per-tile re-render).
- [ ] **All widths**: rendered tile count capped at 600 with "keep
      typing" hint until query length ≥ 2.
- [ ] **All widths**: rows use `content-visibility: auto` +
      `contain-intrinsic-size`.
- [ ] **All widths**: search AND category compose; category does NOT
      clear search.
- [ ] **All widths**: filter state in URL `?q=&scope=&cat=`;
      back-button restores.
- [ ] Console clean, no pageerrors at any viewport.

---

## 10. File-touch ledger for P7

| File | Change |
|---|---|
| `src/web/templates.js` | Header restructure (logo + title + search + CTA + collapsible theme-switcher); family card tall-row template; family detail anchored-TOC; symbol grid container with `auto-fill, minmax()`; global customizer toolbar markup; `/symbols/<name>` detail-route shell; tag chips with per-chip `font-family`. |
| `src/web/serve.js` | Synthesised stylesheet: header collapse at `≤30em`, search reflow, sticky toolbar, `content-visibility: auto` on grid rows, CSS custom props (`--symbol-color`/`-size`/`-weight`/`-scale`, `--sample-text`), container-query rules. Bundle new asset URLs (verify against commit 204a327). |
| `src/web/assets/symbols-page.js` | Wire global toolbar → CSS custom props; sticky search; `?q=&scope=&cat=` URL state; 600-tile cap + "keep typing" hint; route-on-tap (`<1024`) vs inspector (`≥1024`) via `matchMedia`; Cmd-K shortcut; ~80ms debounce. |
| `src/web/assets/fonts-page.js` (new, sibling to `resources-page.js`) | Wire sample input → `--sample-text`; weight slider; italic switch; per-axis variable sliders; per-style row inline-edit override. |
| `src/web/build.js` | Add `/symbols/<name>` route (static if data available, else SPA fallback); add anchored-TOC sections to family detail. |
| `test/unit/web-serve.test.js` | Assert stylesheet contains `content-visibility`, `--symbol-color`, sticky-toolbar; search input has `aria-label`; grid uses `display: grid` + expected `minmax()`. |
| `test/unit/setup.test.js` | Update fixtures if header markup change affects setup-flow snapshot. |
| **Ops runbook (P7 ledger entry, NOT P7 source)** | On mm18: `apple-docs symbols ingest` (P2 #3) → `apple-docs symbols render --reset-cache` (P2 #4) → audit `dist/web/assets/fonts/*` for the stuck `@font-face` URL (P2 #2) → `apple-docs web build`. Document in `docs/runbooks/` as a separate task. |

---

*End of synthesis. Forward to P7.*
