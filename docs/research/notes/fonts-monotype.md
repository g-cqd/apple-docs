# Monotype — monotype.com

Captured 2026-05-06. Browse: `/products/monotype-fonts` (redirected from `/fonts`). Detail: `/fonts/helvetica-now`.

## Important caveat
Monotype.com is the **corporate / enterprise** site, not a consumer tester. The actual catalog with live testers lives behind login at `monotypefonts.com` (subscription product) or via their MyFonts marketplace. The pages we captured are essentially marketing landing pages with no in-page family customizer. Treat findings here as "what the public-facing storefront looks like for an enterprise typeface library", not a tester benchmark.

## Browse page (/products/monotype-fonts)
- **Card grid:** None. The page is a marketing scroll: hero animation showing a Mac-like "Monotype Fonts" desktop app, followed by feature blocks (Compliance, Library access, Collaboration). No families enumerated.
- **Per-card editability:** N/A.
- **Filter/search:** None visible — there's a header search but it queries a separate Help/Knowledge index, not fonts.
- **Sort + sample input:** N/A. Primary CTA is `Book a demo` — selling the subscription.

## Family detail page (/fonts/helvetica-now)
- **Header:** Page title "This is Helvetica Now", a tag list ("Everywhere. Everywhere. Everything"), a hero video (showing the type in motion), `Explore Monotype Fonts` and `Purchase options` outline CTAs. No customizer.
- **Customizer:** **None.** The page is a marketing brochure — animated specimen carousel below the hero, then designer bios, then "Everyone. Everywhere. Everything." section pushing the subscription.
- **Variable axes / Italic / Weight:** None as controls. Specimen images show static settings only.
- **Sample propagation:** N/A.
- **Buy CTA:** `Purchase options` ghost button + `Explore Monotype Fonts` solid blue. Pricing is intentionally hidden until you talk to sales.

## Mobile transformation (360 px)
- Single-column scroll. The hero-video block is replaced by a poster image. The header collapses to logo + search-icon + hamburger + a `Book a demo` blue pill that stays in the top bar.
- A persistent localisation banner ("Diese Seite ist auch auf Deutsch verfügbar") appears at the very top — pushes content down.
- No filters, no customizer — nothing to collapse.

## Time-on-task (cold load -> "Bold sample with my text"):
**Not achievable on this surface.** The user has to leave to MyFonts, monotypefonts.com (login), or contact sales. Time-to-tester is effectively infinite from this page. This is the strongest *anti-pattern* in the set: a font product page with no live preview.
