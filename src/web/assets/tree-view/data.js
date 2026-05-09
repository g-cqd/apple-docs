// Tree-view data loader. The framework page emits the hierarchical
// JSON in one of two places:
//   1. Inline `<script type="application/json" id="tree-data">` — the
//      Bun on-demand fallback inlines this so the page is self-contained.
//   2. External hashed `data-tree-src` on `#tree-container` — the static
//      build emits this so the framework HTML stays small (~50 KB instead
//      of 800 KB on Swift stdlib).
//
// createTreeDataLoader returns a one-shot promise + cache. Two callers
// (ensureListBuilt and ensureTreeBuilt) race on the first request; both
// receive the same parsed payload.

export function readInlineTreeData() {
  const dataEl = document.getElementById('tree-data')
  if (!dataEl) return null
  try {
    return JSON.parse(dataEl.textContent || dataEl.innerText)
  } catch {
    return null
  }
}

export function hasTreeData(treeContainer) {
  return readInlineTreeData() !== null || !!treeContainer.getAttribute('data-tree-src')
}

export function createTreeDataLoader(treeContainer) {
  let cached = null
  let inFlight = null

  function fetchExternal() {
    const src = treeContainer.getAttribute('data-tree-src')
    if (!src) return Promise.resolve(null)
    return fetch(src, { credentials: 'omit' })
      .then(res => res.ok ? res.json() : null)
      .catch(() => null)
  }

  return {
    load() {
      if (cached) return Promise.resolve(cached)
      if (inFlight) return inFlight
      const inline = readInlineTreeData()
      if (inline) {
        cached = inline
        return Promise.resolve(cached)
      }
      inFlight = fetchExternal().then(data => {
        if (data) cached = data
        return cached
      })
      return inFlight
    },
  }
}
