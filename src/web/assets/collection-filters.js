// Framework-listing filter UI: kind chips, fuzzy text filter, deep-link
// state via the URL hash. Operates on the server-rendered list only —
// tree-only pages render neither the list nor these controls.
//
// State + URL serialization lives in collection-filters/state.js; DOM
// rendering in collection-filters/render.js. This module owns the
// lifecycle and event wiring.

import {
  collectKindCounts,
  createFilterState,
  readStateFromHash,
  writeStateToHash,
} from './collection-filters/state.js'
import {
  applyFilters,
  applySort,
  buildControls,
  insertControls,
  syncToc,
} from './collection-filters/render.js'

export function init() {
  const listContainer = document.getElementById('list-container')
  const filterableItems = document.querySelectorAll('[data-filter-kind]')
  if (filterableItems.length === 0) return

  const kindCounts = collectKindCounts({ filterableItems })
  if (kindCounts.size <= 1) return

  const sortedKinds = [...kindCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  const controls = buildControls(sortedKinds)
  const { searchInput, sortSelect, deprecatedCb, bar, allBtn } = controls
  insertControls({ controls, controlsHost: document.getElementById('collection-controls') })

  const state = createFilterState()
  // The original server-rendered HTML — captured before the first kind-sort
  // so we can restore the canonical role-grouped layout when the user
  // selects 'alpha' again.
  let originalListHtml = listContainer ? listContainer.innerHTML : null

  function applyAll() {
    applyFilters(state)
    syncToc()
    writeStateToHash(state)
  }

  // ---- Chip click ----
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-chip')
    if (!btn) return
    const value = btn.getAttribute('data-value')
    if (value === '') {
      state.activeFilters.clear()
      for (const chip of bar.querySelectorAll('.filter-chip')) chip.classList.remove('active')
      btn.classList.add('active')
    } else {
      allBtn.classList.remove('active')
      if (state.activeFilters.has(value)) {
        state.activeFilters.delete(value)
        btn.classList.remove('active')
      } else {
        state.activeFilters.add(value)
        btn.classList.add('active')
      }
      if (state.activeFilters.size === 0) allBtn.classList.add('active')
    }
    applyAll()
  })

  // ---- Sort change ----
  sortSelect.addEventListener('change', () => {
    state.currentSort = sortSelect.value
    applySort(state, originalListHtml)
    syncToc()
    applyAll()
  })

  // ---- Quick search ----
  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value.trim().toLowerCase()
    applyAll()
  })

  // ---- Deprecated toggle ----
  deprecatedCb.addEventListener('change', () => {
    state.hideDeprecated = deprecatedCb.checked
    applyAll()
  })

  // ---- Hash restore ----
  function restore() {
    if (!readStateFromHash(state, kindCounts)) return
    if (state.currentSort === 'kind') {
      sortSelect.value = 'kind'
      applySort(state, originalListHtml)
    }
    for (const v of state.activeFilters) {
      const btn = bar.querySelector(`[data-value="${CSS.escape(v)}"]`)
      if (btn) btn.classList.add('active')
    }
    if (state.activeFilters.size > 0) allBtn.classList.remove('active')
    if (state.searchQuery) searchInput.value = state.searchQuery
    if (state.hideDeprecated) deprecatedCb.checked = true
    applyAll()
  }

  restore()
  syncToc()
}
