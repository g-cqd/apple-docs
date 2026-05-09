import { assetUrl, buildFooter, buildHead, buildHeader, escapeAttr } from '../templates.js'

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
