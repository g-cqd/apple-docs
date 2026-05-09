import { buildFooter, buildHead, buildHeader } from '../templates.js'

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

