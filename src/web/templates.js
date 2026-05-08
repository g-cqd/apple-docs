import { renderHtml, slugify } from '../content/render-html.js'

// ---------------------------------------------------------------------------
// Search page
// ---------------------------------------------------------------------------

/**
 * Render the advanced search page with filter form and results container.
 *
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @returns {string} Complete HTML page string
 */
export function renderSearchPage(siteConfig) {
  const pageTitle = `Search — ${siteConfig.siteName}`
  const canonical = `${siteConfig.baseUrl || ''}/search`
  const description = 'Search Apple developer documentation with filters.'

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description,
  siteConfig,
  canonical,
  ogType: 'website',
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteConfig.siteName,
    url: `${siteConfig.baseUrl || ''}/`,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteConfig.baseUrl || ''}/search?q={query}`,
      'query-input': 'required name=query',
    },
  },
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content search-page">
  <h1>Search Documentation</h1>

  <form class="search-filters" id="search-form" role="search">
    <div class="filter-row filter-row-query">
      <label class="filter-label" for="search-q">Query</label>
      <input class="filter-input" id="search-q" name="q" type="search" placeholder="Symbol, API, or keyword…" autocomplete="off">
    </div>

    <div class="filter-row filter-row-selects">
      <div class="filter-group">
        <label class="filter-label" for="filter-framework">Framework</label>
        <select class="filter-select" id="filter-framework" name="framework" aria-describedby="filter-framework-desc">
          <option value="">All</option>
        </select>
        <span id="filter-framework-desc" class="sr-only">Filter results by framework</span>
      </div>
      <div class="filter-group">
        <label class="filter-label" for="filter-kind">Kind</label>
        <select class="filter-select" id="filter-kind" name="kind" aria-describedby="filter-kind-desc">
          <option value="">All</option>
        </select>
        <span id="filter-kind-desc" class="sr-only">Filter results by symbol kind</span>
      </div>
    </div>

    <div class="filter-row filter-row-toggles">
      <fieldset class="filter-group">
        <legend class="filter-label">Language</legend>
        <div class="filter-chips">
          <label><input type="radio" name="language" value="" checked> All</label>
          <label><input type="radio" name="language" value="swift"> Swift</label>
          <label><input type="radio" name="language" value="objc"> ObjC</label>
        </div>
      </fieldset>
      <fieldset class="filter-group">
        <legend class="filter-label">Platform</legend>
        <div class="filter-chips">
          <label><input type="checkbox" name="platform" value="ios"> iOS</label>
          <label><input type="checkbox" name="platform" value="macos"> macOS</label>
          <label><input type="checkbox" name="platform" value="watchos"> watchOS</label>
          <label><input type="checkbox" name="platform" value="tvos"> tvOS</label>
          <label><input type="checkbox" name="platform" value="visionos"> visionOS</label>
        </div>
      </fieldset>
    </div>

    <details class="filter-advanced">
      <summary>Advanced filters</summary>
      <div class="filter-row filter-row-versions">
        <div class="filter-group">
          <label class="filter-label" for="filter-min-ios">Min iOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-ios" name="min_ios" type="text" placeholder="e.g. 17.0">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-min-macos">Min macOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-macos" name="min_macos" type="text" placeholder="e.g. 14.0">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-min-watchos">Min watchOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-watchos" name="min_watchos" type="text" placeholder="e.g. 10.0">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-min-tvos">Min tvOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-tvos" name="min_tvos" type="text" placeholder="e.g. 17.0">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-min-visionos">Min visionOS</label>
          <input class="filter-input filter-input-sm" id="filter-min-visionos" name="min_visionos" type="text" placeholder="e.g. 1.0">
        </div>
      </div>
      <div class="filter-row">
        <div class="filter-group">
          <label class="filter-label" for="filter-year">WWDC Year</label>
          <input class="filter-input filter-input-sm" id="filter-year" name="year" type="number" placeholder="e.g. 2024">
        </div>
        <div class="filter-group">
          <label class="filter-label" for="filter-track">WWDC Track</label>
          <input class="filter-input filter-input-sm" id="filter-track" name="track" type="text" placeholder="e.g. SwiftUI">
        </div>
      </div>
      <div class="filter-row">
        <label class="filter-checkbox"><input type="checkbox" name="fuzzy" value="1"> Include typo/fuzzy matching</label>
        <label class="filter-checkbox"><input type="checkbox" name="deep" value="1"> Include full-text body search</label>
      </div>
    </details>

    <div class="filter-row filter-row-actions">
      <button type="submit" class="filter-button">Search</button>
    </div>
  </form>

  <div id="search-status" class="search-status" role="status" hidden></div>
  <div id="search-results" class="search-results"></div>
  <button id="search-load-more" class="load-more" hidden aria-label="Load more search results">Load more results</button>
</main>
${buildFooter(siteConfig)}
<script src="${escapeAttr(assetUrl(siteConfig, 'search-page.js'))}" defer></script>
</body>
</html>`
}

/**
 * Static 404 page. Inline JS reads `window.location.pathname` to derive a
 * plausible search query from the URL (e.g. `/docs/swift-book/missing-chapter/`
 * → "missing chapter") and pre-fills the search box. Caddy `handle_errors`
 * + Bun web/serve.js both fall through to this page on /docs/* misses.
 */
export function renderNotFoundPage(siteConfig) {
  const pageTitle = `Not Found — ${siteConfig.siteName}`
  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description: 'The page you requested could not be found.',
  siteConfig,
  // Canonicalise on the homepage so `robots: noindex` actually emits.
  // (buildSeoBlock skips the meta block entirely when canonical is unset.)
  canonical: `${siteConfig.baseUrl || ''}/`,
  ogType: 'website',
  robots: 'noindex',
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content not-found-page">
  <h1>Page not found</h1>
  <p class="not-found-lede">The page you tried to open isn’t in this corpus.</p>
  <p class="not-found-meta">
    <span class="not-found-meta__label">You requested:</span>
    <code id="not-found-url"></code>
  </p>

  <form class="not-found-search" role="search" action="/search">
    <label for="not-found-q" class="not-found-search__label">Search the docs for the title you clicked on:</label>
    <div class="not-found-search__row">
      <input type="search" id="not-found-q" name="q" autocomplete="off" autofocus enterkeyhint="search">
      <button type="submit">Search</button>
    </div>
  </form>

  <p class="not-found-links">
    Or jump to: <a href="/">home</a> · <a href="/search/">search</a> · <a href="/fonts/">fonts</a> · <a href="/symbols/">symbols</a>
  </p>
</main>
${buildFooter(siteConfig)}
<script>
(function () {
  // Derive a search-friendly query from the requested URL. The terminal
  // path segment is the most likely page name; humanize CamelCase / kebab-
  // case / snake_case and decode percent escapes so users land on the
  // search page with a meaningful pre-filled query instead of a blank box.
  var url = window.location;
  var displayUrl = (url.pathname || '') + (url.search || '') + (url.hash || '');
  var urlEl = document.getElementById('not-found-url');
  if (urlEl) urlEl.textContent = displayUrl;

  var path = (url.pathname || '').replace(/\\/+$/, '').replace(/^\\/+/, '');
  // Drop /docs/ prefix and known framework segments — they're not the
  // search target. Keep only the last two segments at most so multi-level
  // misses (e.g. /docs/foo/bar/baz) yield "bar baz".
  if (path.indexOf('docs/') === 0) path = path.slice(5);
  var segs = path.split('/').filter(Boolean).slice(-2);
  var raw = segs.join(' ');
  var pretty = '';
  try { pretty = decodeURIComponent(raw); } catch (_) { pretty = raw; }
  pretty = pretty
    .replace(/[-_]+/g, ' ')                  // kebab/snake → space
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // CamelCase split
    .replace(/\\.html?$/i, '')               // drop terminal .html
    .replace(/\\s+/g, ' ')
    .trim();

  var input = document.getElementById('not-found-q');
  if (input && pretty) {
    input.value = pretty;
    // Pre-select so a single keystroke replaces the inferred query.
    input.select();
  }
})();
</script>
</body>
</html>`
}

export function renderFontsPage(siteConfig, data = {}) {
  const pageTitle = `Fonts — ${siteConfig.siteName}`
  const canonical = `${siteConfig.baseUrl || ''}/fonts`
  const description = 'Browse, preview, and download Apple typography (SF Pro, SF Mono, New York, …).'
  const families = Array.isArray(data.families) ? data.families : []
  const familiesJson = JSON.stringify(families).replace(/</g, '\\u003c')
  const baseUrl = siteConfig.baseUrl || ''

  // Tag inventory — surface category counts. Even a thin taxonomy lets
  // us render a chip strip on mobile and a checklist rail on desktop.
  const categoryCounts = new Map()
  for (const f of families) {
    const cat = f.category ?? 'other'
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1)
  }
  const categoryEntries = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])

  const familyMarkup = families.map(family => {
    const variableCount = family.files.filter(f => f.is_variable).length
    const remoteCount = family.files.filter(f => f.source === 'remote').length
    const systemCount = family.files.filter(f => f.source === 'system').length
    const meta = [
      `${family.files.length} file${family.files.length === 1 ? '' : 's'}`,
      variableCount > 0 ? `${variableCount} variable` : null,
      remoteCount > 0 ? `${remoteCount} remote` : null,
      systemCount > 0 ? `${systemCount} system` : null,
    ].filter(Boolean).join(' · ')
    const categoryLabel = formatFontCategory(family.category)
    const categoryBadge = categoryLabel
      ? `<span class="font-family__badge" data-category="${escapeAttr(family.category)}">${escapeAttr(categoryLabel)}</span>`
      : ''
    const familyZip = (subset) => `${baseUrl}/api/fonts/family/${encodeURIComponent(family.id)}.zip${subset && subset !== 'all' ? `?subset=${encodeURIComponent(subset)}` : ''}`
    const downloadButtons = [
      `<a class="font-family__download" href="${escapeAttr(familyZip('all'))}" download>Download all</a>`,
      variableCount > 0
        ? `<a class="font-family__download font-family__download--alt" href="${escapeAttr(familyZip('variable'))}" download>Variable only</a>`
        : '',
      family.files.length - variableCount > 0
        ? `<a class="font-family__download font-family__download--alt" href="${escapeAttr(familyZip('static'))}" download>Static only</a>`
        : '',
    ].filter(Boolean).join('')
    return `
    <article class="font-family" data-family-id="${escapeAttr(family.id)}" data-family-category="${escapeAttr(family.category ?? 'other')}">
      <header class="font-family__header">
        <div class="font-family__title-row">
          <h2 class="font-family__title">${escapeAttr(family.display_name)}</h2>
          ${categoryBadge}
        </div>
        <p class="font-family__meta">${escapeAttr(meta)}</p>
        <div class="font-family__downloads">${downloadButtons}</div>
      </header>
      <div class="font-family__variants" data-variants></div>
      <div class="font-family__preview" data-preview></div>
    </article>`
  }).join('')

  // Mobile chip strip + desktop rail markup. Categories are radio-style
  // (single-select); JS toggles `[data-active]` on the chosen chip.
  const allCategoriesChip = `<button type="button" class="font-chip" data-category="" data-active="true">All <span class="font-chip__count">${families.length.toLocaleString('en-US')}</span></button>`
  const categoryChips = categoryEntries
    .map(([cat, count]) => {
      const label = formatFontCategory(cat) ?? cat
      return `<button type="button" class="font-chip font-chip--${escapeAttr(cat)}" data-category="${escapeAttr(cat)}">${escapeAttr(label)} <span class="font-chip__count">${count.toLocaleString('en-US')}</span></button>`
    })
    .join('')

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description,
  siteConfig,
  canonical,
  ogType: 'website',
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content fonts-page">
  <header class="fonts-page__header">
    <h1>Apple Fonts</h1>
    <p class="fonts-page__lede">Live preview every family with its real files. Set the sample, size, weight, and italic once — every preview on the page follows. Grab a ZIP per family: all weights, just variable, or just statics.</p>
  </header>

  <section class="fonts-tester" aria-label="Font preview controls">
    <label class="fonts-tester__field">
      <span class="fonts-tester__label">Sample text</span>
      <input id="fonts-sample" class="fonts-tester__sample" type="text" aria-label="Sample text" value="Reading Apple docs in good type." enterkeyhint="done">
    </label>
    <div class="fonts-tester__row">
      <label class="fonts-tester__field fonts-tester__field--size">
        <span class="fonts-tester__label">Size <span id="fonts-size-value">48</span>px</span>
        <input id="fonts-size" type="range" min="12" max="144" value="48" aria-label="Preview size in pixels">
      </label>
      <label class="fonts-tester__field fonts-tester__field--weight">
        <span class="fonts-tester__label">Weight <span id="fonts-weight-value">400</span></span>
        <input id="fonts-weight" type="range" min="100" max="900" step="100" value="400" aria-label="Font weight, 100 to 900">
      </label>
      <label class="fonts-tester__field fonts-tester__field--italic">
        <span class="fonts-tester__label">Italic</span>
        <span class="fonts-tester__switch">
          <input id="fonts-italic" type="checkbox" role="switch" aria-label="Italic">
          <span class="fonts-tester__switch-track" aria-hidden="true"></span>
        </span>
      </label>
      <label class="fonts-tester__field fonts-tester__field--style">
        <span class="fonts-tester__label">Style</span>
        <select id="fonts-style" class="fonts-tester__style" aria-label="Optical-size variant">
          <option value="auto" selected>Auto (best fit)</option>
          <option value="Display">Display</option>
          <option value="Text">Text</option>
          <option value="Rounded">Rounded</option>
          <option value="Small">Small</option>
          <option value="Medium">Medium</option>
          <option value="Large">Large</option>
          <option value="ExtraLarge">Extra Large</option>
        </select>
      </label>
    </div>
    <div class="fonts-tester__chips" id="fonts-chips" role="radiogroup" aria-label="Filter by category">
      ${allCategoriesChip}${categoryChips}
    </div>
  </section>

  <div class="fonts-shell">
    <aside class="fonts-rail" aria-label="Filter">
      <h2 class="fonts-rail__title">Categories</h2>
      <ul class="fonts-rail__list" id="fonts-rail-list">
        ${[`<li><button type="button" class="fonts-rail__btn" data-category="" data-active="true">All <span>${families.length.toLocaleString('en-US')}</span></button></li>`]
          .concat(categoryEntries.map(([cat, count]) => {
            const label = formatFontCategory(cat) ?? cat
            return `<li><button type="button" class="fonts-rail__btn" data-category="${escapeAttr(cat)}">${escapeAttr(label)} <span>${count.toLocaleString('en-US')}</span></button></li>`
          })).join('')}
      </ul>
    </aside>

    <section class="font-family-grid" id="font-family-grid">${familyMarkup}</section>
  </div>

  <div class="fonts-bottom-bar" id="fonts-bottom-bar">
    <a class="fonts-bottom-bar__cta" href="#" id="fonts-bottom-bar-cta" download hidden>Download family</a>
    <a class="fonts-bottom-bar__cta fonts-bottom-bar__cta--all" href="#" id="fonts-bottom-bar-all">Jump to family list</a>
  </div>

  <script id="fonts-data" type="application/json">${familiesJson}</script>
</main>
${buildFooter(siteConfig)}
<script src="${escapeAttr(assetUrl(siteConfig, 'fonts-page.js'))}" defer></script>
</body>
</html>`
}

function formatFontCategory(category) {
  switch (category) {
    case 'sans-serif': return 'Sans-serif'
    case 'serif': return 'Serif'
    case 'monospace': return 'Monospace'
    default: return null
  }
}

export function renderSymbolsPage(siteConfig, data = {}) {
  const pageTitle = `Symbols — ${siteConfig.siteName}`
  const canonical = `${siteConfig.baseUrl || ''}/symbols`
  const description = 'Browse, search, and download SF Symbols. Customize size and colors before exporting SVG or PNG.'
  const totals = Array.isArray(data.totals) ? data.totals : []
  const totalCount = totals.reduce((sum, row) => sum + (row.count ?? 0), 0)
  const publicCount = totals.find(row => row.scope === 'public')?.count ?? 0
  const privateCount = totals.find(row => row.scope === 'private')?.count ?? 0

  // Layout (research/fonts-symbols-ux.md §6):
  //   - global sticky toolbar at top: search · scope · category(mobile) ·
  //     weight · scale · color · size. Values flow into CSS custom props
  //     (`--symbol-color`, `--symbol-size`, `--symbol-weight`,
  //     `--symbol-scale`) so re-styling never touches per-tile DOM.
  //   - 3-column shell on desktop (≥1024): 220px category rail · grid ·
  //     320px inspector. Container-query rules swap column counts when
  //     the inspector opens. <1024 the rail collapses behind a native
  //     <select>, the inspector becomes a dedicated `/symbols/<name>`
  //     route handled in symbols-page.js.
  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description,
  siteConfig,
  canonical,
  ogType: 'website',
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content symbols-page">
  <header class="symbols-page__header">
    <h1>SF Symbols</h1>
    <p class="symbols-page__lede"><span id="symbols-count">${totalCount.toLocaleString('en-US')}</span> symbols indexed (${publicCount.toLocaleString('en-US')} public, ${privateCount.toLocaleString('en-US')} private). Tap a tile to open it; customize size, weight, and color in the toolbar.</p>
  </header>

  <div class="symbols-toolbar" role="search" aria-label="Symbol toolbar">
    <div class="symbols-toolbar__row symbols-toolbar__row--search">
      <input id="symbols-q" class="symbols-search" type="search" placeholder="Search symbols (⌘K)…" aria-label="Search symbols" autocomplete="off" enterkeyhint="search">
      <select id="symbols-scope" class="symbols-scope" aria-label="Scope">
        <option value="">All scopes</option>
        <option value="public">Public</option>
        <option value="private">Private</option>
      </select>
      <select id="symbols-category-mobile" class="symbols-category-mobile" aria-label="Category">
        <option value="">All categories</option>
      </select>
    </div>
    <div class="symbols-toolbar__row symbols-toolbar__row--customize">
      <label class="symbols-control symbols-control--color">
        <span class="symbols-control__legend">Color</span>
        <span class="symbols-color">
          <input id="symbols-color" type="color" value="#000000" aria-label="Symbol color">
          <input id="symbols-color-hex" type="text" value="#000000" pattern="^#[0-9a-fA-F]{6}$" maxlength="7" aria-label="Symbol color hex">
        </span>
      </label>
      <label class="symbols-control symbols-control--size">
        <span class="symbols-control__legend">Tile size <span id="symbols-size-value">48</span>px</span>
        <input id="symbols-size" type="range" min="24" max="120" value="48" aria-label="Tile size in pixels">
      </label>
      <span id="symbols-status" class="symbols-status" role="status" aria-live="polite"></span>
    </div>
  </div>

  <div class="symbols-layout" id="symbols-layout">
    <aside class="symbols-categories" id="symbols-categories" aria-label="Categories">
      <h2 class="symbols-categories__title">Categories</h2>
      <ul class="symbols-categories__list" id="symbols-categories-list" role="listbox" aria-label="Filter by category"></ul>
    </aside>

    <div id="symbols-scroller" class="symbols-scroller" tabindex="0" aria-label="Symbol grid">
      <p id="symbols-typing-hint" class="symbols-typing-hint" hidden></p>
      <div id="symbols-grid" class="symbols-grid" role="grid"></div>
    </div>

    <aside id="symbols-detail" class="symbols-detail" hidden aria-label="Symbol detail">
      <button id="symbols-detail-close" class="symbols-detail__close" type="button" aria-label="Close detail">&times;</button>
      <div class="symbols-detail__preview-wrap">
        <span id="symbols-detail-preview" class="symbols-detail__preview" role="img" aria-label=""></span>
      </div>
      <h2 id="symbols-detail-name" class="symbols-detail__name"></h2>
      <p id="symbols-detail-scope" class="symbols-detail__scope"></p>

      <section class="symbols-detail__axes" aria-label="Variable axes">
        <fieldset class="symbols-control symbols-control--weight">
          <legend class="symbols-control__legend">Weight</legend>
          <div class="symbols-control__pills" role="radiogroup" aria-label="Weight" data-axis="weight">
            <button type="button" class="symbols-pill" role="radio" data-weight="ultralight" aria-checked="false" title="Ultralight">UL</button>
            <button type="button" class="symbols-pill" role="radio" data-weight="thin" aria-checked="false" title="Thin">T</button>
            <button type="button" class="symbols-pill" role="radio" data-weight="light" aria-checked="false" title="Light">L</button>
            <button type="button" class="symbols-pill" role="radio" data-weight="regular" aria-checked="true" title="Regular">R</button>
            <button type="button" class="symbols-pill" role="radio" data-weight="medium" aria-checked="false" title="Medium">M</button>
            <button type="button" class="symbols-pill" role="radio" data-weight="semibold" aria-checked="false" title="Semibold">SB</button>
            <button type="button" class="symbols-pill" role="radio" data-weight="bold" aria-checked="false" title="Bold">B</button>
            <button type="button" class="symbols-pill" role="radio" data-weight="heavy" aria-checked="false" title="Heavy">H</button>
            <button type="button" class="symbols-pill" role="radio" data-weight="black" aria-checked="false" title="Black">Bk</button>
          </div>
        </fieldset>
        <fieldset class="symbols-control symbols-control--scale">
          <legend class="symbols-control__legend">Scale</legend>
          <div class="symbols-control__pills" role="radiogroup" aria-label="Scale" data-axis="scale">
            <button type="button" class="symbols-pill" role="radio" data-scale="small" aria-checked="false" title="Small">S</button>
            <button type="button" class="symbols-pill" role="radio" data-scale="medium" aria-checked="true" title="Medium">M</button>
            <button type="button" class="symbols-pill" role="radio" data-scale="large" aria-checked="false" title="Large">L</button>
          </div>
        </fieldset>
        <p class="symbols-detail__axes-hint" id="symbols-detail-axes-hint" hidden>Weight + scale apply to public SF Symbols only — private CoreGlyphs are bitmap-derived.</p>
      </section>

      <section class="symbols-detail__downloads" aria-label="Downloads">
        <button id="symbols-detail-copy-svg" class="symbols-detail__download symbols-detail__download--primary" type="button">Copy SVG</button>
        <a id="symbols-detail-download-svg" class="symbols-detail__download" href="#" download>Download SVG</a>
        <a id="symbols-detail-download-png" class="symbols-detail__download" href="#" download>Download PNG</a>
      </section>

      <section class="symbols-detail__metadata" aria-label="Metadata">
        <dl id="symbols-detail-meta"></dl>
      </section>
    </aside>
  </div>

  <div class="symbols-mobile-bar" id="symbols-mobile-bar" hidden>
    <button id="symbols-mobile-back" type="button" class="symbols-mobile-bar__back" aria-label="Back to grid">&larr;</button>
    <span id="symbols-mobile-name" class="symbols-mobile-bar__name"></span>
    <button id="symbols-mobile-copy" type="button" class="symbols-mobile-bar__cta">Copy SVG</button>
  </div>
</main>
${buildFooter(siteConfig)}
<script src="${escapeAttr(assetUrl(siteConfig, 'symbols-page.js'))}" defer></script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Escape a value for use inside HTML attribute values or text content. */
function escapeAttr(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function assetUrl(siteConfig, file) {
  const base = `${siteConfig.baseUrl}/assets/${file}`
  if (!siteConfig.assetVersion) return base
  return `${base}?v=${encodeURIComponent(siteConfig.assetVersion)}`
}

// ---------------------------------------------------------------------------
// Shared page-level fragments
// ---------------------------------------------------------------------------

/**
 * Escape a JSON-LD blob so it cannot break out of `<script type="application/ld+json">`.
 * Only `<` and `>` need escaping — `application/ld+json` is parsed as JSON,
 * not JavaScript, so the rest of the string is safe — but tags inside JSON
 * keys/values would still terminate the script element.
 */
function escapeJsonLd(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}

/**
 * Build the SEO meta block: canonical, alternate, OpenGraph, Twitter Card,
 * JSON-LD, and `<meta name="robots">`. Returns an empty string when the
 * caller hasn't provided enough context (e.g. legacy template paths that
 * don't pass `canonical`); doc/framework/index/search templates always pass
 * the right shape.
 */
function buildSeoBlock({ siteConfig, canonical, alternate, ogType, ogTitle, ogDesc, jsonLd, robots }) {
  if (!canonical) return ''
  const lines = []
  lines.push(`<link rel="canonical" href="${escapeAttr(canonical)}">`)
  if (alternate) {
    let altHost = ''
    try { altHost = new URL(alternate).host } catch { /* alternate may be relative */ }
    lines.push(`<link rel="alternate" href="${escapeAttr(alternate)}"${altHost ? ` title="Original on ${escapeAttr(altHost)}"` : ''}>`)
  }
  lines.push(`<meta name="robots" content="${escapeAttr(robots ?? 'index, follow, max-image-preview:large')}">`)

  // OpenGraph + Twitter Card. Both consume the same title/description; we
  // don't ship og:image because Apple's docs don't have a standard hero
  // image we can mirror without licensing concerns.
  const og = {
    'og:type': ogType ?? 'website',
    'og:title': ogTitle ?? siteConfig.siteName,
    'og:url': canonical,
    'og:site_name': siteConfig.siteName,
  }
  if (ogDesc) og['og:description'] = ogDesc
  for (const [property, content] of Object.entries(og)) {
    lines.push(`<meta property="${escapeAttr(property)}" content="${escapeAttr(content)}">`)
  }
  lines.push(`<meta name="twitter:card" content="summary">`)
  lines.push(`<meta name="twitter:title" content="${escapeAttr(ogTitle ?? siteConfig.siteName)}">`)
  if (ogDesc) lines.push(`<meta name="twitter:description" content="${escapeAttr(ogDesc)}">`)

  if (jsonLd) {
    lines.push(`<script type="application/ld+json">${escapeJsonLd(jsonLd)}</script>`)
  }
  return lines.map(l => `  ${l}`).join('\n')
}

function buildHead({ title, description, siteConfig, canonical, alternate, ogType, ogTitle, ogDesc, jsonLd, robots }) {
  const escapedTitle = escapeAttr(title)
  const escapedDesc = escapeAttr(description ?? '')
  const cssHref = assetUrl(siteConfig, 'style.css')
  const headScriptHref = assetUrl(siteConfig, siteConfig.bundled ? 'core.js' : 'theme.js')
  const seo = buildSeoBlock({
    siteConfig,
    canonical,
    alternate,
    ogType,
    ogTitle: ogTitle ?? title,
    ogDesc: ogDesc ?? description,
    jsonLd,
    robots,
  })
  return `<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedTitle}</title>
  ${escapedDesc ? `<meta name="description" content="${escapedDesc}">` : ''}
${seo}
  <link rel="preload" href="${escapeAttr(cssHref)}" as="style">
  <link rel="stylesheet" href="${escapeAttr(cssHref)}">
  <script src="${escapeAttr(headScriptHref)}" defer></script>
</head>`
}

function buildHeader(siteConfig) {
  const homeHref = `${siteConfig.baseUrl}/`
  // /fonts and /symbols deliberately removed from the global header nav —
  // they remain reachable from the home page's Design section. Keeping them
  // out of the header avoids overflow ≤480px (P2 finding #1) and shortens
  // the visual weight of the chrome on every page.
  return `<header class="site-header">
  <nav class="site-nav">
    <a class="site-name" href="${escapeAttr(homeHref)}">${escapeAttr(siteConfig.siteName)}</a>
    <div class="search-container">
      <input class="search-input" type="search" placeholder="Search…" aria-label="Search documentation" autocomplete="off" aria-expanded="false" aria-controls="search-listbox" aria-activedescendant="" aria-autocomplete="list">
      <button class="search-clear" type="button" aria-label="Clear search" hidden>&times;</button>
      <div class="search-dropdown" id="search-listbox" hidden></div>
      <div id="header-search-status" aria-live="assertive" class="sr-only"></div>
    </div>
    <fieldset class="theme-switcher" role="radiogroup" aria-label="Color scheme">
      <button class="theme-option" type="button" role="radio" data-theme-value="light" aria-label="Light theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg></button>
      <button class="theme-option" type="button" role="radio" data-theme-value="auto" aria-label="System theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11" fill="currentColor"/><path d="M8 2.5A5.5 5.5 0 0 1 8 13.5" fill="currentColor"/></svg></button>
      <button class="theme-option" type="button" role="radio" data-theme-value="dark" aria-label="Dark theme"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 9.5A5.5 5.5 0 1 1 6.5 3 4.5 4.5 0 0 0 13 9.5z"/></svg></button>
    </fieldset>
  </nav>
</header>`
}

function buildFooter(siteConfig) {
  const buildDate = escapeAttr(siteConfig.buildDate ?? new Date().toISOString().slice(0, 10))
  return `<footer class="site-footer">
  <p>Built on ${buildDate}</p>
</footer>`
}

// ---------------------------------------------------------------------------
// Script tags — bundled (static build) vs individual (dev server)
// ---------------------------------------------------------------------------

/**
 * Script bundles map. When siteConfig.bundled is true, emit bundles.
 * When false (dev server), emit individual script tags.
 */
const BUNDLES = {
  core: ['theme.js', 'search.js', 'page-toc.js'],
  listing: ['collection-filters.js', 'tree-view.js'],
}

function buildScripts(siteConfig, groups) {
  if (siteConfig.bundled) {
    return groups
      .filter(g => g !== 'core')
      .map(g => {
        const file = BUNDLES[g] ? `${g}.js` : `${g}.js`
        return `<script src="${escapeAttr(assetUrl(siteConfig, file))}" defer></script>`
      })
      .join('\n')
  }
  // Dev mode — emit individual files
  const files = []
  for (const g of groups) {
    if (BUNDLES[g]) {
      for (const f of BUNDLES[g]) files.push(f)
    } else {
      files.push(`${g}.js`)
    }
  }
  return files.map(f =>
    `<script src="${escapeAttr(assetUrl(siteConfig, f))}" defer></script>`
  ).join('\n')
}

// ---------------------------------------------------------------------------
// Breadcrumbs
// ---------------------------------------------------------------------------

/**
 * Build a breadcrumb nav HTML string from a slash-separated doc key.
 *
 * Example: `documentation/swiftui/view` produces:
 *   <a href="/docs/documentation/">documentation</a> /
 *   <a href="/docs/documentation/swiftui/">swiftui</a> /
 *   view
 *
 * The last segment is rendered as plain text (current page).
 * A single-segment key produces plain text with no link.
 */
export function buildBreadcrumbs(key, opts = {}) {
  if (!key || typeof key !== 'string') return ''
  const segments = key.split('/').filter(Boolean)
  if (segments.length === 0) return ''

  // Use the document title for the last segment instead of the raw path
  const lastLabel = opts.title ?? segments[segments.length - 1]
  if (segments.length === 1) {
    return `<nav class="breadcrumbs" aria-label="Breadcrumb"><span>${escapeAttr(lastLabel)}</span></nav>`
  }

  // Ancestor title lookup (maps partial key path -> display title)
  const ancestorTitles = opts.ancestorTitles ?? new Map()
  // Set of corpus keys that actually resolve to a rendered page. Intermediate
  // path segments are common in non-DocC sources (swift-book/LanguageGuide/X,
  // apple-archive/documentation/AppleApplications/Conceptual/...) where the
  // joining segments are filesystem directories with no corresponding page.
  // Linking those produces 404s; render them as plain text instead.
  const knownKeys = opts.knownKeys ?? null

  const parts = []
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1
    const partialKey = segments.slice(0, i + 1).join('/')

    let label
    if (isLast) {
      label = lastLabel
    } else if (i === 0 && opts.framework) {
      // First segment is the framework slug — use the display name
      label = opts.framework
    } else if (ancestorTitles.has(partialKey)) {
      label = ancestorTitles.get(partialKey)
    } else {
      label = segments[i]
    }

    // The root segment (`/docs/<framework>/`) always resolves: it's served
    // either by a stored doc page or by renderFrameworkPage at the
    // framework slug. Don't gate it through knownKeys.
    const isFrameworkRoot = i === 0
    if (isLast) {
      parts.push(`<span aria-current="page">${escapeAttr(label)}</span>`)
    } else if (knownKeys && !isFrameworkRoot && !knownKeys.has(partialKey)) {
      // Intermediate hop has no corresponding page — keep the label visible
      // for context but don't dangle a 404 link off it.
      parts.push(`<span>${escapeAttr(label)}</span>`)
    } else {
      const href = `/docs/${partialKey}/`
      parts.push(`<a href="${escapeAttr(href)}">${escapeAttr(label)}</a>`)
    }
  }

  return `<nav class="breadcrumbs" aria-label="Breadcrumb">${parts.join('<span class="breadcrumb-sep" aria-hidden="true"> / </span>')}</nav>`
}

// ---------------------------------------------------------------------------
// Original-resource link helpers
// ---------------------------------------------------------------------------

/**
 * Derive the upstream URL for a root/framework record. Documents carry a
 * per-page `url` column, but framework landing pages don't — we synthesize
 * from source_type + slug.
 */
function frameworkOriginalUrl(root) {
  if (!root) return null
  if (root.url) return root.url
  const slug = root.slug ?? ''
  switch (root.source_type) {
    case 'hig': return 'https://developer.apple.com/design/human-interface-guidelines'
    case 'guidelines': return 'https://developer.apple.com/app-store/review/guidelines/'
    case 'wwdc': return 'https://developer.apple.com/videos/'
    case 'sample-code': return 'https://developer.apple.com/sample-code/'
    case 'swift-evolution': return 'https://www.swift.org/swift-evolution/'
    case 'swift-book': return 'https://docs.swift.org/swift-book/'
    case 'swift-org': return 'https://www.swift.org/'
    case 'apple-archive': return 'https://developer.apple.com/library/archive/'
    case 'packages': return 'https://swiftpackageindex.com/'
    default: return slug ? `https://developer.apple.com/documentation/${slug}` : null
  }
}

/** Short hostname label ("developer.apple.com") used in the link text. */
function hostLabel(url) {
  try { return new URL(url).host } catch { return '' }
}

/**
 * Render the "Original resource" sidebar block. Returns an empty string when
 * no upstream URL is available.
 */
function buildOriginalResourceBlock(url) {
  if (!url) return ''
  const host = hostLabel(url)
  return `<div class="sidebar-block sidebar-source">
  <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="sidebar-source-link">Open on ${escapeAttr(host || 'source')}</a>
</div>`
}

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

function buildDocMeta(doc) {
  const badges = []
  const frameworkLabel = doc.framework_display ?? doc.framework
  if (frameworkLabel) {
    badges.push(`<span class="badge badge-framework">${escapeAttr(frameworkLabel)}</span>`)
  }
  if (doc.role_heading) {
    badges.push(`<span class="badge badge-role">${escapeAttr(doc.role_heading)}</span>`)
  }
  if (doc.is_deprecated) {
    badges.push('<span class="badge badge-deprecated">Deprecated</span>')
  }
  if (doc.is_beta) {
    badges.push('<span class="badge badge-beta">Beta</span>')
  }

  // Platform availability badges
  const platforms = parsePlatformsJson(doc.platforms_json)
  const platformBadges = buildPlatformBadges(platforms)

  const parts = []
  if (badges.length > 0) parts.push(`<div class="doc-meta">${badges.join('')}</div>`)
  if (platformBadges) parts.push(platformBadges)
  return parts.join('\n  ')
}

/** Parse platforms_json from DB (string or object). */
function parsePlatformsJson(platformsJson) {
  if (!platformsJson) return null
  if (typeof platformsJson === 'object') return platformsJson
  try { return JSON.parse(platformsJson) } catch { return null }
}

/** Build a platform availability line from a platforms map. */
function buildPlatformBadges(platforms) {
  if (!platforms || typeof platforms !== 'object') return ''
  const platformNames = {
    ios: 'iOS', macos: 'macOS', watchos: 'watchOS', tvos: 'tvOS',
    visionos: 'visionOS', maccatalyst: 'Mac Catalyst', ipados: 'iPadOS',
  }
  const items = []
  for (const [slug, version] of Object.entries(platforms)) {
    if (!version) continue
    const name = platformNames[slug] ?? slug
    items.push(`<span class="badge badge-platform">${escapeAttr(name)} ${escapeAttr(version)}+</span>`)
  }
  if (items.length === 0) return ''
  return `<div class="doc-availability">${items.join('')}</div>`
}

// ---------------------------------------------------------------------------
// Relationship sidebar
// ---------------------------------------------------------------------------

/** Returns the inner HTML content of the relationships sidebar (without the wrapping <aside>). */
function buildRelationshipContent(section) {
  const contentJson = section?.content_json ?? section?.contentJson ?? null
  let groups = null
  if (contentJson && typeof contentJson === 'string') {
    try { groups = JSON.parse(contentJson) } catch { /* ignore */ }
  } else if (contentJson && typeof contentJson === 'object') {
    groups = contentJson
  }

  const parts = ['<h2>Relationships</h2>']

  if (Array.isArray(groups) && groups.length > 0) {
    for (const group of groups) {
      if (group?.title) {
        parts.push(`<h3 class="sidebar-group-title">${escapeAttr(group.title)}</h3>`)
      }
      const items = (group?.items ?? [])
        .map(item => {
          if (item?.key) {
            return `<li><a href="/docs/${escapeAttr(item.key)}/"><code>${escapeAttr(item.title ?? item.key)}</code></a></li>`
          }
          return `<li>${escapeAttr(item?.title ?? item?.identifier ?? '')}</li>`
        })
        .join('')
      if (items) {
        parts.push(`<ul class="sidebar-list">${items}</ul>`)
      }
    }
  } else {
    parts.push('<p class="sidebar-hint">See relationships section in the article.</p>')
  }

  return parts.join('\n  ')
}

// ---------------------------------------------------------------------------
// Page TOC (Table of Contents)
// ---------------------------------------------------------------------------

/** Build TOC item list from ordered sections. Skips abstract and empty sections. */
function buildPageToc(sections) {
  const items = []
  for (const section of sections ?? []) {
    const kind = section.sectionKind ?? section.section_kind
    if (kind === 'abstract') continue

    // Skip sections that have no renderable content
    const text = section.contentText ?? section.content_text ?? ''
    const json = section.contentJson ?? section.content_json ?? null
    const hasText = typeof text === 'string' && text.trim().length > 0
    const hasJson = json != null && (typeof json === 'string' ? json.trim().length > 0 : true)
    if (!hasText && !hasJson) continue

    // For link sections (topics, relationships, see_also), check if the parsed
    // JSON actually has items — an empty group list produces no visible content
    if (kind === 'topics' || kind === 'relationships' || kind === 'see_also') {
      if (!hasRenderableItems(json)) continue
    }

    let id, label
    switch (kind) {
      case 'declaration':
        id = 'declaration'; label = 'Declaration'; break
      case 'parameters':
        id = 'parameters'; label = 'Parameters'; break
      case 'properties':
        label = section.heading ?? 'Properties'
        id = slugify(label)
        break
      case 'rest_endpoint':
        label = section.heading ?? 'URL'
        id = slugify(label)
        break
      case 'rest_parameters':
        label = section.heading ?? 'Parameters'
        id = slugify(label)
        break
      case 'rest_responses':
        label = section.heading ?? 'Response Codes'
        id = slugify(label)
        break
      case 'possible_values':
        label = section.heading ?? 'Possible Values'
        id = slugify(label)
        break
      case 'mentioned_in':
        id = 'mentioned-in'; label = 'Mentioned in'; break
      case 'discussion':
        label = section.heading ?? 'Overview'
        id = slugify(label)
        break
      case 'topics':
        id = 'topics'; label = 'Topics'; break
      case 'relationships':
        continue // rendered in sidebar, not in article body
      case 'see_also':
        id = 'see-also'; label = 'See Also'; break
      default:
        label = section.heading ?? 'Section'
        id = slugify(label)
    }
    if (id) items.push({ id, label })
  }
  return items
}

/** Check if a JSON content string (or parsed object) for a link section has at least one renderable item. */
function hasRenderableItems(json) {
  if (!json) return false
  let groups = null
  if (typeof json === 'string') {
    try { groups = JSON.parse(json) } catch { return false }
  } else if (Array.isArray(json)) {
    groups = json
  } else {
    return false
  }
  if (!Array.isArray(groups)) return false
  for (const group of groups) {
    const items = group?.items ?? []
    if (items.length > 0) return true
  }
  return false
}

/** Render the TOC HTML. In mobile mode, wraps in a <details> element. */
function renderTocHtml(tocItems, mobile = false) {
  if (tocItems.length < 2) return ''
  const listHtml = `<ul>${tocItems.map(item =>
    `<li><a href="#${escapeAttr(item.id)}">${escapeAttr(item.label)}</a></li>`
  ).join('')}</ul>`

  if (mobile) {
    return `<details class="page-toc-mobile"><summary>Contents</summary><nav class="page-toc">${listHtml}</nav></details>`
  }
  return `<nav class="page-toc">${listHtml}</nav>`
}

// ---------------------------------------------------------------------------
// Page templates
// ---------------------------------------------------------------------------

/**
 * Render a complete HTML5 page for a single documentation document.
 *
 * @param {object} doc - Document record (title, key, framework, role_heading, source_type, abstract_text)
 * @param {Array}  sections - Section records passed to renderHtml()
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @param {object} [opts] - { resolveRoleHeadings?: (keys: string[]) => Map<string, string> }
 * @returns {string} Complete HTML page string
 */
export function renderDocumentPage(doc, sections, siteConfig, opts = {}) {
  const sectionsList = sections ?? []

  // Enrich topics items with role_heading from DB (if resolver provided)
  if (opts.resolveRoleHeadings) {
    enrichTopicItems(sectionsList, opts.resolveRoleHeadings)
  }

  const pageTitle = `${doc.title ?? 'Untitled'} — ${siteConfig.siteName}`
  const renderOpts = {}
  if (opts.knownKeys) renderOpts.knownKeys = opts.knownKeys
  let content = renderHtml(doc, sectionsList, renderOpts)

  // Detect multi-language declarations for language toggle
  const hasLangToggle = content.includes('data-languages=')
  const breadcrumbs = doc.key ? buildBreadcrumbs(doc.key, {
    title: doc.title,
    framework: doc.framework_display ?? doc.framework,
    ancestorTitles: opts.ancestorTitles,
    knownKeys: opts.knownKeys,
  }) : ''

  // Sort sections for TOC (same order as renderHtml uses)
  const orderedSections = sectionsList.slice().sort((a, b) =>
    (a.sortOrder ?? a.sort_order ?? 0) - (b.sortOrder ?? b.sort_order ?? 0)
  )
  const tocItems = buildPageToc(orderedSections)

  const relationshipSection = orderedSections.find(s =>
    (s.sectionKind ?? s.section_kind) === 'relationships'
  )

  const hasSidebar = tocItems.length >= 2

  // When sidebar renders relationships separately, mark the in-article duplicate as hidden from assistive tech
  if (hasSidebar) {
    content = content.replace('<section id="relationships">', '<section id="relationships" aria-hidden="true">')
  }

  // Build doc meta (badges + platforms)
  const docMeta = buildDocMeta(doc)

  // Compose sidebar as a stack of discrete blocks:
  // Original-resource → meta → language toggle → TOC → relationships.
  const sidebarParts = []
  const originalBlock = buildOriginalResourceBlock(doc.url)
  if (originalBlock) sidebarParts.push(originalBlock)
  if (docMeta) {
    sidebarParts.push(`<div class="sidebar-block sidebar-meta">${docMeta}</div>`)
  }
  if (hasLangToggle) {
    sidebarParts.push(`<div class="sidebar-block">
  <div class="lang-toggle" role="group" aria-label="Language">
    <button class="lang-btn active" data-lang="swift" aria-pressed="true">Swift</button>
    <button class="lang-btn" data-lang="occ" aria-pressed="false">ObjC</button>
  </div>
</div>`)
  }
  if (hasSidebar) {
    sidebarParts.push(`<div class="sidebar-block">${renderTocHtml(tocItems, false)}</div>`)
  }
  if (relationshipSection) {
    const relJson = relationshipSection.contentJson ?? relationshipSection.content_json ?? ''
    if (typeof relJson === 'string' ? hasRenderableItems(relJson) : true) {
      sidebarParts.push(`<div class="sidebar-block">${buildRelationshipContent(relationshipSection)}</div>`)
    }
  }

  const sidebar = sidebarParts.length > 0
    ? `<aside class="doc-sidebar">${sidebarParts.join('\n')}</aside>`
    : ''

  const hasSidebarFinal = sidebar.length > 0

  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : ''

  const canonical = doc.key ? `${siteConfig.baseUrl || ''}/docs/${doc.key}/` : null
  const docDescription = doc.abstract_text || `${doc.title ?? ''} — Apple developer documentation`.trim()
  const platforms = parsePlatformsJson(doc.platforms_json) || {}
  const platformNames = Object.keys(platforms).filter(k => platforms[k]).map(k => ({
    ios: 'iOS', macos: 'macOS', watchos: 'watchOS', tvos: 'tvOS', visionos: 'visionOS',
    maccatalyst: 'Mac Catalyst', ipados: 'iPadOS',
  }[k] ?? k))
  const programmingLanguage = (doc.language === 'occ' || doc.language === 'objc') ? 'Objective-C' : 'Swift'
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: doc.title ?? 'Untitled',
    inLanguage: 'en',
    isAccessibleForFree: true,
    mainEntityOfPage: canonical,
    publisher: {
      '@type': 'Organization',
      name: siteConfig.siteName,
      url: `${siteConfig.baseUrl || ''}/`,
    },
    ...(docDescription ? { description: docDescription } : {}),
    ...(siteConfig.buildDate ? { dateModified: siteConfig.buildDate } : {}),
    ...(doc.url ? { isBasedOn: doc.url } : {}),
    ...(programmingLanguage ? { programmingLanguage } : {}),
    ...(platformNames.length > 0 ? { audience: { '@type': 'Audience', audienceType: 'Developers' }, applicationSuite: platformNames.join(', ') } : {}),
  }

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description: doc.abstract_text,
  siteConfig,
  canonical,
  alternate: doc.url || null,
  ogType: 'article',
  ogTitle: doc.title ?? pageTitle,
  ogDesc: docDescription,
  jsonLd,
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content${hasSidebarFinal ? ' has-sidebar' : ''}">
  ${breadcrumbs}
  ${mobileToc}
  <article class="doc-article">
    ${content}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
${buildScripts(siteConfig, ['core', ...(hasLangToggle ? ['lang-toggle'] : [])])}
</body>
</html>`
}

/** Batch-enrich topics section items with _resolvedRoleHeading from DB. */
function enrichTopicItems(sections, resolveRoleHeadings) {
  for (const section of sections) {
    const kind = section.sectionKind ?? section.section_kind
    if (kind !== 'topics') continue

    const raw = section.contentJson ?? section.content_json
    let contentJson = null
    if (typeof raw === 'string') {
      try { contentJson = JSON.parse(raw) } catch { continue }
    } else if (typeof raw === 'object') {
      contentJson = raw
    }
    if (!Array.isArray(contentJson)) continue

    // Collect all item keys
    const keys = []
    for (const group of contentJson) {
      for (const item of group?.items ?? []) {
        if (item.key) keys.push(item.key)
      }
    }
    if (keys.length === 0) continue

    // Batch resolve
    const roleMap = resolveRoleHeadings(keys)

    // Enrich items
    for (const group of contentJson) {
      for (const item of group?.items ?? []) {
        if (item.key && roleMap.has(item.key)) {
          item._resolvedRoleHeading = roleMap.get(item.key)
        }
      }
    }

    // Write back serialized
    const serialized = JSON.stringify(contentJson)
    if (section.contentJson !== undefined) {
      section.contentJson = serialized
    } else {
      section.content_json = serialized
    }
  }
}

/**
 * Render the index/landing page listing all frameworks grouped by kind.
 *
 * @param {Array}  frameworks - Framework records (slug, name, kind, doc_count)
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @returns {string} Complete HTML page string
 */
export function renderIndexPage(frameworks, siteConfig, opts = {}) {
  const pageTitle = siteConfig.siteName
  const frameworkList = frameworks ?? []

  // Group frameworks by kind, preserving insertion order
  const byKind = new Map()
  for (const fw of frameworkList) {
    const kind = fw.kind ?? 'other'
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push(fw)
  }

  // Extras hook — synthetic entries (e.g. /fonts, /symbols inside Design)
  // that aren't real corpus roots. They render as normal list items with
  // a custom href.
  const extrasByKind = opts.extras ?? {}
  for (const [kind, extras] of Object.entries(extrasByKind)) {
    if (!byKind.has(kind)) byKind.set(kind, [])
    byKind.get(kind).push(...extras)
  }

  const sections = []
  for (const [kind, items] of byKind) {
    const itemsHtml = items.map(fw => {
      const href = fw.href ?? `${siteConfig.baseUrl}/docs/${escapeAttr(fw.slug)}/`
      const countBadge = fw.doc_count != null
        ? ` <span class="badge badge-count">${escapeAttr(String(fw.doc_count))}</span>`
        : ''
      return `<li data-filter-kind="${escapeAttr(kind)}"><a href="${href}">${escapeAttr(fw.display_name ?? fw.name ?? fw.slug)}</a>${countBadge}</li>`
    }).join('\n      ')

    const kindId = slugify(kind)
    sections.push(`<section id="${escapeAttr(kindId)}" class="framework-group" data-filter-kind="${escapeAttr(kind)}">
    <h2 class="framework-kind">${escapeAttr(kind)}</h2>
    <ul class="framework-list">
      ${itemsHtml}
    </ul>
  </section>`)
  }

  const mainContent = sections.length > 0
    ? sections.join('\n  ')
    : '<p>No frameworks indexed yet.</p>'

  // Build sidebar TOC from kind groups
  const tocItems = [...byKind.keys()].map(kind => ({ id: slugify(kind), label: kind }))
  const hasSidebar = tocItems.length >= 2
  const sidebar = hasSidebar
    ? `<aside class="doc-sidebar"><div class="sidebar-block">${renderTocHtml(tocItems, false)}</div></aside>`
    : ''
  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : ''

  const description = 'Apple developer documentation, indexed locally.'
  const canonical = `${siteConfig.baseUrl || ''}/`

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description,
  siteConfig,
  canonical,
  ogType: 'website',
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteConfig.siteName,
    url: canonical,
    description,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${siteConfig.baseUrl || ''}/search?q={query}`,
      'query-input': 'required name=query',
    },
  },
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content${hasSidebar ? ' has-sidebar' : ''} listing">
  <h1>${escapeAttr(siteConfig.siteName)}</h1>
  ${mobileToc}
  <article class="doc-article">
  ${mainContent}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
${buildScripts(siteConfig, ['core', 'listing'])}
</body>
</html>`
}

/**
 * Compute the framework tree-view JSON ahead of rendering. Build.js uses this
 * to write a hashed, externally-cacheable `tree.<hash>.json` file and pass
 * back the URL via `opts.treeDataUrl` to `renderFrameworkPage`. Keeping this
 * exported lets us assert framework-page weight in tests without re-running
 * the entire page render.
 *
 * @param {object} framework
 * @param {Array}  documents
 * @param {Array<{from_key: string, to_key: string}>} treeEdges
 * @param {object} siteConfig
 * @returns {{ json: string, hasTree: boolean }} `json` is empty when the
 *   framework has no tree edges (and so no tree-view).
 */
export function buildFrameworkTreeData(framework, documents, treeEdges, siteConfig) {
  if (!treeEdges || treeEdges.length === 0) return { json: '', hasTree: false }

  const docList = documents ?? []
  const docLookup = {}
  for (const doc of docList) {
    const docKey = doc.key ?? doc.path ?? ''
    docLookup[docKey] = {
      title: doc.title ?? docKey,
      role_heading: doc.role_heading ?? doc.role ?? 'Other',
      href: `${siteConfig.baseUrl ?? ''}/docs/${docKey}/`,
    }
  }

  // Same role grouping the inline path emits when deferList is on (which is
  // always true when hasTree is true).
  const ROLE_LABELS = {
    symbol: 'Symbols', collection: 'Collections', collectionGroup: 'Collection Groups',
    sampleCode: 'Sample Code', article: 'Articles', dictionarySymbol: 'Dictionary Symbols',
    overview: 'Overview', pseudoSymbol: 'Pseudo Symbols',
    restRequestSymbol: 'REST Requests', link: 'Links',
  }
  const byRole = new Map()
  for (const doc of docList) {
    const rawRole = doc.role ?? doc.role_heading ?? 'Other'
    const role = ROLE_LABELS[rawRole] ?? rawRole
    if (!byRole.has(role)) byRole.set(role, [])
    byRole.get(role).push(doc)
  }
  const roleGroups = []
  for (const [role, roleDocs] of byRole) {
    roleGroups.push({
      role,
      id: slugify(role),
      docs: roleDocs.map(doc => {
        const docKey = doc.key ?? doc.path ?? ''
        const isSymbol = doc.role === 'symbol' || doc.role === 'dictionarySymbol' || doc.role === 'pseudoSymbol' || doc.role === 'restRequestSymbol'
        return {
          key: docKey,
          title: doc.title ?? docKey,
          role_heading: doc.role_heading ?? doc.role ?? 'Other',
          abstract: doc.abstract_text ?? doc.abstract ?? '',
          deprecated: /\bDeprecated\b/i.test(doc.abstract_text ?? doc.abstract ?? ''),
          symbol: isSymbol,
        }
      }),
    })
  }

  return {
    json: JSON.stringify({ edges: treeEdges, docs: docLookup, roleGroups }),
    hasTree: true,
  }
}

/**
 * Render a framework listing page with documents grouped by role.
 *
 * @param {object} framework - Framework record (name, slug, kind)
 * @param {Array}  documents - Document records (title, key, role, role_heading)
 * @param {object} siteConfig - { baseUrl, siteName, buildDate }
 * @param {object} [opts] - { treeEdges?: Array<{from_key: string, to_key: string}> }
 * @returns {string} Complete HTML page string
 */
export function renderFrameworkPage(framework, documents, siteConfig, opts = {}) {
  const fwName = framework?.display_name ?? framework?.name ?? framework?.slug ?? 'Framework'
  const pageTitle = `${fwName} — ${siteConfig.siteName}`
  const docList = documents ?? []
  const treeEdges = opts.treeEdges ?? []

  // Human-readable labels for DocC roles
  const ROLE_LABELS = {
    symbol: 'Symbols',
    collection: 'Collections',
    collectionGroup: 'Collection Groups',
    sampleCode: 'Sample Code',
    article: 'Articles',
    dictionarySymbol: 'Dictionary Symbols',
    overview: 'Overview',
    pseudoSymbol: 'Pseudo Symbols',
    restRequestSymbol: 'REST Requests',
    link: 'Links',
  }

  // Group documents by role
  const byRole = new Map()
  for (const doc of docList) {
    const rawRole = doc.role ?? doc.role_heading ?? 'Other'
    const role = ROLE_LABELS[rawRole] ?? rawRole
    if (!byRole.has(role)) byRole.set(role, [])
    byRole.get(role).push(doc)
  }

  const roleSections = []
  for (const [role, docs] of byRole) {
    const docsHtml = docs.map(doc => {
      const docKey = doc.key ?? doc.path ?? ''
      const href = `${siteConfig.baseUrl}/docs/${escapeAttr(docKey)}/`
      const title = escapeAttr(doc.title ?? docKey)
      const filterKind = escapeAttr(doc.role_heading ?? doc.role ?? 'Other')
      // Show role_heading as metadata to distinguish duplicates (e.g. .!=(_:_:) across types)
      const meta = doc.role_heading ? `<span class="doc-item-meta">${escapeAttr(doc.role_heading)}</span>` : ''
      const abstractText = doc.abstract_text ?? doc.abstract ?? ''
      const isDeprecated = /\bDeprecated\b/i.test(abstractText)
      const abstract = abstractText
        ? `<span class="doc-item-meta">— ${escapeAttr(abstractText.length > 80 ? abstractText.slice(0, 80) + '...' : abstractText)}</span>`
        : ''
      const deprecatedAttr = isDeprecated ? ' data-deprecated="true"' : ''
      const isSymbol = doc.role === 'symbol' || doc.role === 'dictionarySymbol' || doc.role === 'pseudoSymbol' || doc.role === 'restRequestSymbol'
      const titleHtml = isSymbol ? `<code>${title}</code>` : title
      return `<li data-filter-kind="${filterKind}"${deprecatedAttr}><a href="${href}">${titleHtml}</a>${meta}${abstract}</li>`
    }).join('\n      ')

    const roleId = slugify(role)
    roleSections.push(`<section id="${escapeAttr(roleId)}" class="role-group" data-filter-kind="${escapeAttr(role)}">
    <h2 class="role-heading">${escapeAttr(role)}</h2>
    <ul class="doc-list">
      ${docsHtml}
    </ul>
  </section>`)
  }

  const mainContent = roleSections.length > 0
    ? roleSections.join('\n  ')
    : '<p>No documents found for this framework.</p>'

  // View toggle only shown when we have tree edges
  const hasTree = treeEdges.length > 0

  // When tree view is default, skip rendering the full list HTML server-side.
  // The list is hidden on load and contains thousands of <li> elements that bloat
  // the HTML payload (e.g., Swift stdlib: 10 MB HTML, 138k DOM nodes, 53s FCP).
  // Instead, collection-filters.js will build the list on-demand when the user
  // switches to list view.
  const deferList = hasTree

  const breadcrumbs = `<nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <span aria-current="page">${escapeAttr(fwName)}</span></nav>`

  // Build sidebar: original-resource block + TOC of role groups.
  const tocItems = [...byRole.keys()].map(role => ({ id: slugify(role), label: role }))
  const hasSidebar = tocItems.length >= 2
  const sidebarBlocks = []
  const originalBlock = buildOriginalResourceBlock(frameworkOriginalUrl(framework))
  if (originalBlock) sidebarBlocks.push(originalBlock)
  if (hasSidebar) sidebarBlocks.push(`<div class="sidebar-block">${renderTocHtml(tocItems, false)}</div>`)
  const sidebar = sidebarBlocks.length > 0
    ? `<aside class="doc-sidebar">${sidebarBlocks.join('\n')}</aside>`
    : ''
  const mobileToc = hasSidebar ? renderTocHtml(tocItems, true) : ''

  // Build the doc lookup JSON for tree view (key -> {title, role_heading, href})
  const docLookup = {}
  for (const doc of docList) {
    const docKey = doc.key ?? doc.path ?? ''
    docLookup[docKey] = {
      title: doc.title ?? docKey,
      role_heading: doc.role_heading ?? doc.role ?? 'Other',
      href: `${siteConfig.baseUrl}/docs/${docKey}/`,
    }
  }

  // Build role grouping for deferred list rendering
  const roleGroups = []
  if (deferList) {
    for (const [role, roleDocs] of byRole) {
      roleGroups.push({
        role,
        id: slugify(role),
        docs: roleDocs.map(doc => {
          const docKey = doc.key ?? doc.path ?? ''
          const isSymbol = doc.role === 'symbol' || doc.role === 'dictionarySymbol' || doc.role === 'pseudoSymbol' || doc.role === 'restRequestSymbol'
          return {
            key: docKey,
            title: doc.title ?? docKey,
            role_heading: doc.role_heading ?? doc.role ?? 'Other',
            abstract: doc.abstract_text ?? doc.abstract ?? '',
            deprecated: /\bDeprecated\b/i.test(doc.abstract_text ?? doc.abstract ?? ''),
            symbol: isSymbol,
          }
        }),
      })
    }
  }

  // Plain JSON for the tree data. When the caller provides
  // `opts.treeDataUrl`, the framework page emits an external reference
  // instead of inlining this — see the `<div id="tree-container">` below
  // and `tree-view.js`. Inline emission still escapes HTML-significant
  // characters to prevent `</script>` breakout.
  const treeDataObj = { edges: treeEdges, docs: docLookup, ...(deferList ? { roleGroups } : {}) }
  const treeDataJsonInline = JSON.stringify(treeDataObj)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('/', '\\u002f')
    .replaceAll('&', '\\u0026')
  const externalTreeDataUrl = opts.treeDataUrl ?? null

  const viewToggle = hasTree
    ? `<div class="view-toggle" role="group" aria-label="View mode">
    <button data-view="list" aria-pressed="false">List</button>
    <button class="active" data-view="tree" aria-pressed="true">Tree</button>
  </div>`
    : ''

  const description = `${fwName} documentation index.`
  const canonical = framework?.slug ? `${siteConfig.baseUrl || ''}/docs/${framework.slug}/` : null
  const originalUrl = frameworkOriginalUrl(framework)
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'APIReference',
    name: fwName,
    inLanguage: 'en',
    description,
    isAccessibleForFree: true,
    ...(canonical ? { mainEntityOfPage: canonical } : {}),
    ...(siteConfig.buildDate ? { dateModified: siteConfig.buildDate } : {}),
    ...(originalUrl ? { isBasedOn: originalUrl } : {}),
    programmingLanguage: 'Swift',
  }

  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
${buildHead({
  title: pageTitle,
  description,
  siteConfig,
  canonical,
  alternate: originalUrl,
  ogType: 'website',
  ogTitle: fwName,
  ogDesc: description,
  jsonLd,
})}
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>
${buildHeader(siteConfig)}
<main id="main-content" class="main-content${sidebar ? ' has-sidebar' : ''} listing">
  ${breadcrumbs}
  <h1>${escapeAttr(fwName)}${viewToggle}</h1>
  ${mobileToc}
  <article class="doc-article">
  <div id="collection-controls"${deferList ? ' class="hidden"' : ''}></div>
  <div id="list-container"${hasTree ? ' class="hidden"' : ''}${deferList ? ' data-deferred' : ''}>
  ${deferList ? '' : mainContent}
  </div>
  <div id="tree-container"${externalTreeDataUrl ? ` data-tree-src="${escapeAttr(externalTreeDataUrl)}"` : ''}></div>
  ${hasTree && !externalTreeDataUrl ? `<script type="application/json" id="tree-data">${treeDataJsonInline}</script>` : ''}
  </article>
  ${sidebar}
</main>
${buildFooter(siteConfig)}
${buildScripts(siteConfig, ['core', 'listing'])}
</body>
</html>`
}
