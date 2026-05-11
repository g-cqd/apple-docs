import { assetUrl, buildFooter, buildHead, buildHeader, escapeAttr } from '../templates.js'

export function renderFontsPage(siteConfig, data = {}) {
  const pageTitle = `Fonts — ${siteConfig.siteName}`
  const canonical = `${siteConfig.baseUrl || ''}/fonts`
  const description = 'Browse, preview, and download Apple typography (SF Pro, SF Mono, New York, …).'
  const families = Array.isArray(data.families) ? data.families : []
  const familiesJson = JSON.stringify(families).replace(/</g, '\\u003c')
  const baseUrl = siteConfig.baseUrl || ''

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
    <article class="font-family" data-family-id="${escapeAttr(family.id)}">
      <header class="font-family__header">
        <div class="font-family__title-row">
          <h2 class="font-family__title">${escapeAttr(family.display_name)}</h2>
        </div>
        <p class="font-family__meta">${escapeAttr(meta)}</p>
        <div class="font-family__downloads">${downloadButtons}</div>
      </header>
      <div class="font-family__variants" data-variants></div>
      <div class="font-family__preview" data-preview></div>
    </article>`
  }).join('')

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
  </section>

  <section class="font-family-grid" id="font-family-grid">${familyMarkup}</section>

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

