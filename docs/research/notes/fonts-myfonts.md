# MyFonts — myfonts.com

Captured 2026-05-06. Browse: `/` (home with bestseller carousel — `/collections/best-sellers` and `/browse` both 404'd; the homepage carousel is the canonical browse surface). Detail: `/collections/tt-norms-font-typetype`.

## Browse page
- **Card grid:** Carousel-driven, not a flat grid. Homepage shows a 4-up promotional carousel of "New / Bestsellers / Special Offers" — each card is a poster (sample word in the family + foundry name + price-from). Lower sections expand into a 2-3 column grid of "Special Offers". 1440 px shows ~4 carousel cards. Mobile is a 1-up carousel with dots.
- **Per-card editability:** No. Cards are fixed posters; the actual customizer lives on the family page.
- **Filter/search:** No persistent left rail anywhere. Discovery is mediated by the top mega-menu ("Browse by", "Categories", "Bestsellers", "Hot New Fonts") and a global search bar with image-search and "AI Search" buttons (paid). The *content* of search-results pages does include a left filter rail (when reachable).
- **Sort + sample input:** No browse-level sample text input. Inputting text only works on the family page.

## Family detail page anatomy
- **Header:** Promotional sale banner running across the top (e.g. "30% Off"), breadcrumb (Home / Fonts / TypeType / TT Norms Pro), family name, foundry, designers list, "Individual Styles from <strikethrough> €X" pricing block top-right.
- **Tabs:** As All Glyphs | Family Packages | Individual Styles | Tech Specs | Licensing — segmented bar.
- **Customizer:** Single sample-text input ("Enter your text here.") with `aA` size toggle, alignment buttons, and a `Reset` link — a thin horizontal strip above the style list. Compact, but the sample input is the only customizer (no italic/weight global controls).
- **Style list:** Each style is a row showing the user's sample text rendered in that style, with the style name and a per-style buy CTA. Selecting "Family Packages" tab shows bundle cards with savings ("Best Value!" badge, "Buying Choices" CTA).
- **Variable axes:** Not surfaced as sliders; variable cuts are listed as fixed style entries.
- **Italic toggle / weight switching:** None. User scans the row list (Condensed Thin, Condensed Thin Italic, Extra Light, Extra Light Italic, ... 100+ rows for TT Norms Pro).
- **Buy CTA:** Two-tier — green `Buying Choices` (for the pack) and a "Best Value!" card for the family bundle. Strong commercial framing; "Add family" doesn't exist — it's a marketplace.

## Mobile transformation (360 px)
- Hamburger menu replaces the mega-menu. Search is icon-only.
- Sample-text input stays inline above the style list. The size toggle and alignment buttons squeeze onto one row.
- Family Packages and Individual Styles become an accordion (the screenshot shows "Family Packages" pre-expanded; tapping it collapses to show Individual Styles).
- Sticky promotional banner at the top — large vertical real estate cost.

## Time-on-task (cold load -> "Bold sample with my text"):
1. Tap family. 2. Tap sample input. 3. Type. 4. Scroll to find a "Bold" row in the long flat list.
**3 taps + significant scroll**. No weight filter or jump-to.
