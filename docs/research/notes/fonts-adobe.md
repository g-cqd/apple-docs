# Adobe Fonts — fonts.adobe.com

Captured 2026-05-06. Browse: `/fonts`. Detail: `/fonts/source-sans-3`.

## Browse page
- **Card grid:** Three-column grid at 1440 px (large rectangular cards showing one big glyph or word in the family's hero style). Cards are visual posters, not text testers — ~9 cards per fold. Drops to 2 columns at 1024 px and 1 column at 768 px.
- **Per-card editability:** No. Each card shows a fixed promotional setting; users edit globally via the toolbar.
- **Filter/search:** Persistent left rail >=1024 px (Languages and Writing Systems, Font Technology + variable check, Tags as visual chips with sample lettering ("Calligraphic", "Clean", "Brush Pen"), Classification icon-buttons (Sans Serif, Serif, Slab, Script, Mono, Hand)). Adobe uniquely renders the *tag values* in the visual style they describe — extremely browsable.
- **Sort + sample input:** Top toolbar holds View toggle (List/Grid), Images on/off, Sample Text dropdown (presets only — no free input on browse), Text Size slider, Sort (Featured / A-Z / Newest). Filters button at <=768 px opens a modal sheet titled "Show Filters".

## Family detail page anatomy
- **Header:** Family name (large), designer line, save-actions row (Favorites, Library, Web Project icons), bold black `Add family` pill CTA top-right.
- **Tabs:** Fonts | Recommendations | About | Licensing | Details — secondary nav under the title.
- **Customizer:** Compact horizontal toolbar above the styles list: View (List/Grid), Sample Text dropdown (preset selection), Text Size slider. *No* free-text sample input on the family page (you pick presets like "Paragraph", "Numerals", or via an "Edit" affordance inside the dropdown).
- **Variable axes:** Adobe surfaces variable controls inline under the family hero, but only when the family has them — sliders look like Text-Size's slider style.
- **Italic toggle / weight switching:** No global toggles. Each style is an independent row in the list (e.g. "Source Sans 3 ExtraLight", "...ExtraLight Italic", "...Light", ...). User scans visually.
- **Per-row preview:** Every style row shows the chosen sample text rendered in that exact weight/italic. Right side of each row has icons (Favorite, copy CSS `</>`) and a per-style `Add font` button — user can sync individual cuts.
- **Download/Buy CTA:** "Add family" / "Add font" — Adobe Fonts uses subscription sync, not download. CTA is high-contrast black pill, both top-right and per row.

## Mobile transformation (360 px)
- Customizer **inlines** above the styles list — no drawer. View / Sample Text / Text Size stack vertically full-width.
- Browse filters collapse to a single `Show Filters` pill that opens a vertical modal (the *only* mobile filter affordance — a hard tap-cost gate).
- Floating help bubble (`?`) bottom-right — sticky throughout. Top header is sticky on scroll.

## Time-on-task (cold load -> "I see Bold sample with my text"):
1. Tap family. 2. Tap Sample Text dropdown -> 3. tap "Type your own" / edit. 4. Scroll to Bold row.
**3 taps + 1 scroll** — no editable in-row sample, so user must scan visually rather than dial up a weight.
