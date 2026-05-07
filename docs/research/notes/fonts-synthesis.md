# Font marketplace UX synthesis

Cross-site analysis of Google Fonts, Adobe Fonts, MyFonts, Fontspring, Monotype.
Captured 2026-05-06 at five viewports (1440 / 1024 / 768 / 480 / 360). Screenshots in `docs/research/screenshots/fonts/<site>/`.

## Pattern matrix

| Feature | Google Fonts | Adobe Fonts | MyFonts | Fontspring | Monotype |
|---|---|---|---|---|---|
| Browse sample-text input | Single global, free text, top toolbar; live to all cards | Preset dropdown only (no free input on browse) | None at browse level | Single global, free text, hero-prominent | None |
| Detail sample-text input | Single global, drives all per-style rows; per-row override available | Preset dropdown; per-row preview but no per-row override | Single global with size+align toggle | Single global in "Type tester" section | None |
| Weight selector | Continuous slider (variable) + per-style pills below | None — flat list of every cut as rows | None — flat list of cuts | None — flat list of cuts | N/A |
| Italic selector | Standalone iOS switch | None — italics are separate rows | None — italics are separate rows | None — italics are separate rows | N/A |
| Variable axes | Per-axis sliders (label + numeric) inline with weight | Inline sliders when family supports them | Not surfaced as sliders | Tag filter only on browse | N/A |
| Filter ergonomics | Persistent left rail; collapses to "Filters" button + drawer < 1024 px | Persistent left rail with visual tag chips (sample lettering); "Show Filters" sheet < 1024 px | No persistent rail; mega-menu + global search | Persistent accordion left rail; pill button on mobile | None |
| Sort control | Inline dropdown in top toolbar | Inline dropdown in top toolbar | Sort hidden in top mega-menu | Explicit "Sort By" dropdown above filters | N/A |
| Download / Buy CTA | Single sticky `Get font` pill (top-right, persistent on mobile) | Black pill `Add family` (top-right) + per-row `Add font` | Tiered pricing block + `Buying Choices` green button + Family Bundle "Best Value!" | Purple `Buy family` + outline `Try` (top-right); sticky bottom action bar on mobile | `Purchase options` + `Explore` (no in-page tester) |
| Mobile customizer container | Inline accordion above preview | Inline above style list | Inline above style list (compact strip) | Inline within "Type tester" section + sticky bottom bar | N/A |
| Mobile filter container | Drawer behind `Filters` button | Modal sheet behind `Show Filters` button | None / mega-menu hamburger | Full-screen sheet behind `Filters` pill | N/A |
| Sticky elements | Top header + `Get font` CTA | Top header + help bubble | Promo banner (top) | Top header + bottom action bar (mobile) | Top header + `Book a demo` |
| Card density (1440 px) | 1 col, ~6 families/fold (atmospheric) | 3 col, ~9 families/fold (poster cards) | Carousel, 4-up + 2-3 col grids | 1 col, ~3 families/fold (huge previews) | None (marketing scroll) |
| Tag/filter visualisation | Text chips | Text *rendered in the tag's style* (e.g. "Brush Pen" in a brush) | N/A | Text checkbox accordion | N/A |

## Top 5 patterns to copy

1. **One global sample-text input that propagates to every preview** (Google, Fontspring). It's the single most powerful affordance: any user understands it, no mode-switch is required, and it works across browse and detail. Make it big, top-of-page, free-text, no preset gate.
2. **Per-style row that can also be edited inline** (Google detail). The global input sets the default; clicking a row's text lets the user override just that row to compare e.g. headlines vs. body. Cheap to implement, high "play" value.
3. **Variable axes as named sliders co-located with Weight/Italic** (Google). One panel, one mental model, sliders with both a label and a live numeric readout, large hit areas. Italic stays a separate switch — never folded into the weight axis.
4. **Sticky primary CTA** (`Get font` / `Add family` / `Buy family`) (Google, Adobe, Fontspring). Always one visually distinctive pill, top-right on desktop and persistent on mobile via either a sticky header or sticky bottom bar (Fontspring's pattern is best for thumb reach).
5. **Visual tag chips** (Adobe). Render filter values in the visual style they describe — a "Calligraphic" chip set in a calligraphic face, "Geometric" in a geo sans. Massively faster to scan than text.

## Top 3 anti-patterns to avoid

1. **A font product page with no live tester** (Monotype). Forcing the user to leave to a separate property to actually try the type is the single biggest conversion killer. Always include at minimum a sample-text input + style preview on the family page.
2. **Forcing preset-only sample text** (Adobe browse). Users want to type their own brand name / headline. A preset dropdown without a free-text option turns a 1-tap interaction into a 3-tap "Edit" hunt.
3. **A flat list of 100+ style rows with no weight or italic filter** (MyFonts, Fontspring detail). When a family has 50+ cuts, force a control that lets the user filter to "regular weights only", "italics off", etc., or scroll death will set in.

## Recommendations for our /fonts page

Concrete, small, implementable for the apple-docs `/fonts` surface:

1. **One sample-text `<input>` at the top**, full-width, free text. Default to a copy line that demonstrates ascenders/descenders/punctuation (e.g. *"Reading Apple docs in good type."*). Wire it via a `customElement` or simple `input` listener that sets a CSS custom property `--sample-text` consumed by every preview block via `::before { content: var(--sample-text); }`.
2. **One layout per breakpoint, not three.** Single-column, very tall family rows at all widths (Google + Fontspring pattern). Avoid three-column poster grids — they look great empty but waste vertical space when populated and break the editable-sample mental model.
3. **Customizer = stacked sliders/switches inline above the style list.** No drawer, no modal. Order: sample input -> font-size slider -> weight slider (if variable) -> italic switch -> variable-axis sliders (one per axis, labelled). Hit targets >=44 px, with numeric readouts inline.
4. **Render tag filter values in their own style** if we have category filters (Sans / Serif / Mono / Display). Cheap CSS win.
5. **Sticky top bar with the family name and a single primary CTA** (e.g. `Open in Apple Docs` / `Copy CSS`). Keeps the user oriented during long scrolls through styles.
6. **Per-style row preview with click-to-edit inline override.** Default text comes from the global input; click locks that row's text so the user can type "Headline" in Bold and "body copy" in Regular side-by-side.
7. **Mobile: persistent bottom action bar** (Fontspring pattern) with the same primary CTA. Better thumb reach than a sticky top header on phones.
8. **No carousels.** They hide content, are non-deterministic in screenshots, and add JS weight. A vertical list with virtualised rendering scales further with less complexity (and matches Google Fonts' approach, which is the industry benchmark for this exact UX).
