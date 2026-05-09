// URL-state contract for the symbols page.
//   ?q=…&scope=…&cat=…  filter state
//   /symbols/<name>     detail-route (mobile + bookmark-friendly)
// Both layers compose: /symbols/<name>?cat=… is valid.

export function parseDetailRoute(pathname) {
  const m = pathname.match(/^\/symbols\/(.+?)\/?$/)
  return m ? decodeURIComponent(m[1]) : null
}

export function readUrlState() {
  const params = new URLSearchParams(window.location.search)
  return {
    q: params.get('q') || '',
    scope: params.get('scope') || '',
    cat: params.get('cat') || '',
  }
}

export function writeUrlState({ q, scope, cat }) {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (scope) params.set('scope', scope)
  if (cat) params.set('cat', cat)
  const qs = params.toString()
  const detailName = parseDetailRoute(window.location.pathname)
  const path = detailName ? `/symbols/${encodeURIComponent(detailName)}` : '/symbols'
  const next = qs ? `${path}?${qs}` : path
  if (next !== `${window.location.pathname}${window.location.search}`) {
    history.replaceState(history.state, '', next)
  }
}
