import { assetUrl, buildFooter, buildHead, buildHeader, escapeAttr } from '../templates.js'

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
