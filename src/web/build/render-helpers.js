/**
 * Per-page render helpers — promise-race timeout wrapper and the
 * skiplist placeholder fallback for documents that wedge the synchronous
 * render path.
 * Extracted from build.js as part of P3.8.
 */

export function renderWithTimeout(fn, ms) {
  let timer
  const renderPromise = Promise.resolve().then(fn)
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`render timeout after ${ms}ms`)), ms)
  })
  return Promise.race([renderPromise, timeoutPromise]).finally(() => clearTimeout(timer))
}

/**
 * Minimal placeholder for skiplisted documents. Emits a valid HTML page
 * with the doc's title, abstract, and a link back to the upstream Apple
 * URL — enough for SEO + the sitemap, with a banner explaining that the
 * full body is unavailable.
 */
export function renderSkiplistPlaceholder(doc, siteConfig) {
  const esc = (s) => String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
  const title = esc(doc.title ?? doc.key)
  const description = esc(doc.abstract_text ?? `${doc.title ?? doc.key} — Apple developer documentation`)
  const canonical = `${siteConfig.baseUrl || ''}/docs/${esc(doc.key)}/`
  const upstream = doc.url ? esc(doc.url) : null
  return `<!DOCTYPE html>
<html lang="en" data-theme="auto">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ${esc(siteConfig.siteName)}</title>
  <meta name="description" content="${description}">
  <link rel="canonical" href="${canonical}">
  ${upstream ? `<link rel="alternate" href="${upstream}">` : ''}
  <meta name="robots" content="index, follow">
</head>
<body>
<main class="main-content">
  <h1>${title}</h1>
  <p>${description}</p>
  <p><em>Body unavailable in this build — see the original on Apple's site${upstream ? `: <a href="${upstream}">${upstream}</a>` : ''}.</em></p>
</main>
</body>
</html>`
}

/**
 * Partition a framework list across N workers, balancing by document count
 * via greedy bin-packing (largest framework first into the smallest bin).
 * Apple's distribution is heavy-tailed (kernel = 39 K docs, swift-evolution
 * = 553), so a naive round-robin would leave one worker rendering swift +
 * uikit while five sit idle. This balances within ~5 % of optimal.
 */
