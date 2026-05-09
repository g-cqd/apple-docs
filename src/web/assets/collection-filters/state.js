// Collection-filter state: kind counts, current selection, URL-hash
// serialization. All pure helpers — the controller wires them onto DOM
// events.

export function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Build the kind → count map from either the rendered list (sync mode)
 * or the inline tree-data JSON (deferred mode where the list HTML hasn't
 * been built yet).
 */
export function collectKindCounts({ isDeferred, filterableItems }) {
  const kindCounts = new Map()
  if (isDeferred) {
    const dataEl = document.getElementById('tree-data')
    if (dataEl) {
      try {
        const td = JSON.parse(dataEl.textContent || '')
        if (td.roleGroups) {
          for (const group of td.roleGroups) {
            for (const doc of group.docs) {
              const kind = doc.role_heading || 'Other'
              kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1)
            }
          }
        }
      } catch { /* ignore */ }
    }
  } else {
    for (const el of filterableItems) {
      if (el.tagName !== 'LI') continue
      const kind = el.getAttribute('data-filter-kind')
      kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1)
    }
  }
  return kindCounts
}

export function createFilterState() {
  return {
    activeFilters: new Set(),
    currentSort: 'alpha',
    searchQuery: '',
    hideDeprecated: false,
  }
}

/**
 * Replace the URL hash with the current state, or strip it when the state
 * is the default. Uses replaceState so back-button history isn't polluted
 * with one entry per chip click.
 */
export function writeStateToHash(state) {
  const params = []
  if (state.currentSort !== 'alpha') params.push(`sort=${state.currentSort}`)
  if (state.activeFilters.size > 0) params.push(`filter=${[...state.activeFilters].join(',')}`)
  if (state.searchQuery) params.push(`q=${encodeURIComponent(state.searchQuery)}`)
  if (state.hideDeprecated) params.push('hideDeprecated=1')

  const base = location.pathname + location.search
  if (params.length === 0) {
    history.replaceState(null, '', base)
  } else {
    history.replaceState(null, '', `${base}#${params.join('&')}`)
  }
}

/**
 * Parse the URL hash back into the state object. Mutates state in place.
 * Returns true when any non-default value was restored — caller decides
 * whether to re-apply filters.
 */
export function readStateFromHash(state, kindCounts) {
  const hash = location.hash
  if (!hash || hash.length < 2) return false

  const map = new Map()
  for (const pair of hash.slice(1).split('&')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    map.set(pair.slice(0, idx), pair.slice(idx + 1))
  }

  let touched = false
  if (map.get('sort') === 'kind') { state.currentSort = 'kind'; touched = true }
  if (map.has('filter')) {
    for (const v of map.get('filter').split(',').filter(Boolean)) {
      if (kindCounts.has(v)) {
        state.activeFilters.add(v)
        touched = true
      }
    }
  }
  if (map.has('q')) {
    try { state.searchQuery = decodeURIComponent(map.get('q')) } catch { state.searchQuery = map.get('q') }
    if (state.searchQuery) touched = true
  }
  if (map.get('hideDeprecated') === '1') { state.hideDeprecated = true; touched = true }

  return touched
}
