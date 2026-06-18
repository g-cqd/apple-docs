// Tree-view controller for framework listing pages. Loads the
// hierarchical JSON and renders the tree; on scope-grouped roots
// (which server-render their curated list) it also drives the
// list/tree toggle.
//
// Data loading lives in tree-view/data.js, state derivation in
// tree-view/state.js, DOM rendering in tree-view/render.js. This module
// owns the event bindings and the lifecycle.

import { createTreeDataLoader, hasTreeData } from './tree-view/data.js'
import { applyTreeFilters, expandLazy, renderNode } from './tree-view/render.js'
import { buildTreeState } from './tree-view/state.js'

export function init() {
  const treeContainer = document.getElementById('tree-container')
  if (!treeContainer) return

  // Present only on scope-grouped roots, where the server renders the
  // curated list and the tree is the optional view. Tree-only pages
  // (symbol frameworks) ship neither list nor toggle.
  const listContainer = document.getElementById('list-container')
  const collectionControls = document.getElementById('collection-controls')

  // Bail out early if no tree data exists at all (legacy frameworks without
  // DocC `topics` relationships) — the list HTML is already rendered
  // server-side in that case.
  if (!hasTreeData(treeContainer)) return

  const loader = createTreeDataLoader(treeContainer)

  // ---- View toggle (sync; data load is gated downstream) ----
  function setViewMode(mode) {
    if (mode === 'tree') {
      listContainer?.classList.add('hidden')
      treeContainer.classList.remove('hidden')
      if (collectionControls) collectionControls.classList.add('hidden')
      ensureTreeBuilt()
    } else if (listContainer) {
      treeContainer.classList.add('hidden')
      listContainer.classList.remove('hidden')
      if (collectionControls) collectionControls.classList.remove('hidden')
    }
  }

  const viewToggle = document.querySelector('.view-toggle')
  if (viewToggle) {
    viewToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]')
      if (!btn) return

      const mode = btn.getAttribute('data-view')
      for (const b of viewToggle.querySelectorAll('button')) {
        b.classList.remove('active')
        b.setAttribute('aria-pressed', 'false')
      }
      btn.classList.add('active')
      btn.setAttribute('aria-pressed', 'true')

      setViewMode(mode)
    })
  }

  // ---- Tree state (lazy-initialised once data arrives) ----
  let treeState = null
  let treeBuilt = false
  let inflight = false

  treeContainer.addEventListener(
    'toggle',
    (e) => {
      const details = e.target.closest('details.tree-node')
      if (!details?.open || !treeState) return
      const lazyUl = details.querySelector(':scope > ul[data-lazy-parent]')
      if (lazyUl) {
        expandLazy(treeState, treeContainer, lazyUl.getAttribute('data-lazy-parent'))
      }
    },
    true,
  )

  function ensureTreeBuilt() {
    if (treeBuilt || inflight) return
    inflight = true
    treeContainer.innerHTML = '<p class="loading">Loading tree…</p>'
    loader.load().then((data) => {
      inflight = false
      if (!data) {
        treeContainer.innerHTML = '<p>Failed to load tree data.</p>'
        return
      }
      treeState = buildTreeState(data)
      treeBuilt = true

      const parts = []
      parts.push(`<div class="tree-actions">
  <button id="tree-expand-all" type="button">Expand all</button>
  <button id="tree-collapse-all" type="button">Collapse all</button>
</div>`)

      const visited = new Set()
      for (const key of treeState.rootKeys) {
        parts.push(renderNode(treeState, key, 0, 2, visited))
      }
      // Orphans that have children but aren't reached from any root.
      for (const key of treeState.children.keys()) {
        if (!visited.has(key)) {
          parts.push(renderNode(treeState, key, 0, 2, visited))
        }
      }

      treeContainer.innerHTML = parts.join('\n')
      bindBulkButtons()
      applyTreeFilters(treeContainer)
    })
  }

  function bindBulkButtons() {
    const expandAllBtn = document.getElementById('tree-expand-all')
    const collapseAllBtn = document.getElementById('tree-collapse-all')

    if (expandAllBtn) {
      expandAllBtn.addEventListener('click', async () => {
        expandAllBtn.disabled = true
        expandAllBtn.textContent = 'Expanding…'
        while (true) {
          const lazyEls = treeContainer.querySelectorAll('[data-lazy-parent]')
          if (lazyEls.length === 0) break
          const batch = [...lazyEls].slice(0, 20)
          for (const el of batch) expandLazy(treeState, treeContainer, el.getAttribute('data-lazy-parent'))
          await new Promise((r) => requestAnimationFrame(r))
        }
        const allDetails = [...treeContainer.querySelectorAll('details.tree-node')]
        for (let i = 0; i < allDetails.length; i += 100) {
          for (let j = i; j < Math.min(i + 100, allDetails.length); j++) {
            allDetails[j].open = true
          }
          await new Promise((r) => requestAnimationFrame(r))
        }
        expandAllBtn.disabled = false
        expandAllBtn.textContent = 'Expand all'
      })
    }

    if (collapseAllBtn) {
      collapseAllBtn.addEventListener('click', () => {
        for (const d of treeContainer.querySelectorAll('details.tree-node')) {
          d.open = false
        }
      })
    }
  }

  // ---- Integration with collection-filters ----
  const filterBar = document.querySelector('.collection-filter-bar')
  if (filterBar) {
    filterBar.addEventListener('click', () => {
      if (treeBuilt) requestAnimationFrame(() => applyTreeFilters(treeContainer))
    })
  }

  // The server picks the default view: scope-grouped roots ship their
  // curated list (with a toggle when tree edges exist); everything else
  // is tree-only. Without a toggle the tree IS the page — build it now.
  if (viewToggle?.getAttribute('data-default-view') === 'list') {
    setViewMode('list')
  } else {
    setViewMode('tree')
  }
}
