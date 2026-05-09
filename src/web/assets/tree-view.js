// Tree-view controller for framework listing pages. Loads the
// hierarchical JSON (inline or via /data/frameworks/<slug>/tree.<hash>.json),
// builds the lazy tree DOM, and switches between flat-list and tree
// modes. Emits `list-container:ready` so collection-filters.js knows when
// to re-bind handlers against the rebuilt list.
//
// Phase 2: native ES module with explicit init() called from
// listing.bundle.js. Body unchanged — IIFE -> function rename only.
export function init() {
  const treeContainer = document.getElementById('tree-container')
  const listContainer = document.getElementById('list-container')
  if (!treeContainer || !listContainer) return

  const collectionControls = document.getElementById('collection-controls')

  // Tree data may live in one of two places:
  //   1. Inline `<script type="application/json" id="tree-data">…</script>`
  //      — emitted by Bun's on-demand `/docs/<key>/` fallback so the
  //      framework page is self-contained when a static prebuild is missing.
  //   2. External hashed file referenced by `data-tree-src` on
  //      `#tree-container` — emitted by the static build, so the framework
  //      HTML stays small (~50 KB instead of 800 KB on Swift stdlib) and
  //      the JSON is fetched lazily.
  let treeData = null
  let treeDataPromise = null

  function readInlineTreeData() {
    const dataEl = document.getElementById('tree-data')
    if (!dataEl) return null
    try {
      return JSON.parse(dataEl.textContent || dataEl.innerText)
    } catch {
      return null
    }
  }

  function fetchExternalTreeData() {
    const src = treeContainer.getAttribute('data-tree-src')
    if (!src) return Promise.resolve(null)
    return fetch(src, { credentials: 'omit' })
      .then(res => res.ok ? res.json() : null)
      .catch(() => null)
  }

  function loadTreeData() {
    if (treeData) return Promise.resolve(treeData)
    if (treeDataPromise) return treeDataPromise
    const inline = readInlineTreeData()
    if (inline) {
      treeData = inline
      return Promise.resolve(treeData)
    }
    treeDataPromise = fetchExternalTreeData().then(data => {
      if (data) treeData = data
      return treeData
    })
    return treeDataPromise
  }

  // Bail out early if no tree data exists at all (legacy frameworks without
  // DocC `topics` relationships) — the list HTML is already rendered
  // server-side in that case.
  if (!readInlineTreeData() && !treeContainer.getAttribute('data-tree-src')) {
    return
  }

  // ---- Escape HTML ----
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // ---- View toggle (sync; data load is gated downstream by the
  // ensureTreeBuilt / ensureListBuilt entry points) ----
  function setViewMode(mode) {
    if (mode === 'tree') {
      listContainer.classList.add('hidden')
      treeContainer.classList.remove('hidden')
      if (collectionControls) collectionControls.classList.add('hidden')
      ensureTreeBuilt()
    } else {
      treeContainer.classList.add('hidden')
      listContainer.classList.remove('hidden')
      if (collectionControls) collectionControls.classList.remove('hidden')
      ensureListBuilt()
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

  // ---- Deferred list rendering ----
  // When the server skips the list HTML (data-deferred), build it client-
  // side from the `roleGroups` array in the tree JSON.
  let listBuilt = !listContainer.hasAttribute('data-deferred')

  function ensureListBuilt() {
    if (listBuilt) return
    listBuilt = true
    listContainer.removeAttribute('data-deferred')
    listContainer.innerHTML = '<p class="loading">Loading…</p>'
    loadTreeData().then(data => {
      if (!data || !data.roleGroups || data.roleGroups.length === 0) {
        listContainer.innerHTML = '<p>No documents found for this framework.</p>'
        return
      }

      const html = data.roleGroups.map(group => {
        const items = group.docs.map(doc => {
          const titleHtml = doc.symbol ? `<code>${esc(doc.title)}</code>` : esc(doc.title)
          const meta = doc.role_heading ? `<span class="doc-item-meta">${esc(doc.role_heading)}</span>` : ''
          const abstractText = doc.abstract
          const abstract = abstractText
            ? `<span class="doc-item-meta">— ${esc(abstractText.length > 80 ? abstractText.slice(0, 80) + '...' : abstractText)}</span>`
            : ''
          const deprecatedAttr = doc.deprecated ? ' data-deprecated="true"' : ''
          return `<li data-filter-kind="${esc(doc.role_heading)}"${deprecatedAttr}><a href="/docs/${esc(doc.key)}/">${titleHtml}</a>${meta}${abstract}</li>`
        }).join('\n      ')

        return `<section id="${esc(group.id)}" class="role-group" data-filter-kind="${esc(group.role)}">
    <h2 class="role-heading">${esc(group.role)}</h2>
    <ul class="doc-list">
      ${items}
    </ul>
  </section>`
      }).join('\n  ')

      listContainer.innerHTML = html
      document.dispatchEvent(new CustomEvent('list-container:ready'))
    })
  }

  // ---- Tree state (lazy-initialised once data arrives) ----
  let treeBuilt = false
  let inflight = false

  // These refs are populated by `initTreeStateFrom(data)` and used by every
  // tree-rendering helper below. Until then the helpers are unreachable
  // because `ensureTreeBuilt` is the only entry point.
  let docs = null
  let children = null
  let rootKeys = null
  const descendantCounts = new Map()

  function initTreeStateFrom(data) {
    docs = data.docs
    const edges = data.edges
    children = new Map()
    const childSet = new Set()
    for (const { from_key, to_key } of edges) {
      let kids = children.get(from_key)
      if (!kids) {
        kids = []
        children.set(from_key, kids)
      }
      kids.push(to_key)
      childSet.add(to_key)
    }

    // Root nodes appear as parent but never as child.
    const allParents = [...children.keys()]
    rootKeys = allParents.filter(k => !childSet.has(k))

    // Sort children alphabetically within each parent by title.
    const titleOf = (k) => (docs[k]?.title ?? k).toLowerCase()
    for (const [, kids] of children) {
      kids.sort((a, b) => {
        const ta = titleOf(a)
        const tb = titleOf(b)
        return ta < tb ? -1 : ta > tb ? 1 : 0
      })
    }
    rootKeys.sort((a, b) => {
      const ta = titleOf(a)
      const tb = titleOf(b)
      return ta < tb ? -1 : ta > tb ? 1 : 0
    })

    // Memoised descendant counts for the badges next to each tree node.
    const visited = new Set()
    function count(key) {
      if (visited.has(key)) return 0
      visited.add(key)
      const kids = children.get(key)
      if (!kids) { descendantCounts.set(key, 0); return 0 }
      let total = kids.length
      for (const k of kids) total += count(k)
      descendantCounts.set(key, total)
      return total
    }
    for (const key of rootKeys) count(key)
    for (const key of children.keys()) if (!visited.has(key)) count(key)
  }

  // ---- Disambiguate overloads: items sharing a title get a parent prefix ----
  function disambiguateChildren(parentKey, childKeys) {
    const titleCounts = new Map()
    for (const key of childKeys) {
      const t = docs[key]?.title ?? key
      titleCounts.set(t, (titleCounts.get(t) || 0) + 1)
    }
    const parentTitle = docs[parentKey]?.title ?? parentKey
    const result = new Map()
    for (const key of childKeys) {
      const t = docs[key]?.title ?? key
      if (titleCounts.get(t) > 1) {
        result.set(key, `${parentTitle}.${t}`)
      }
    }
    return result
  }

  // ---- Chain compaction: walk down single-child chains to one label ----
  function compactChain(key) {
    const parts = [docs[key]?.title || key]
    const seen = new Set([key])
    let cur = key
    while (true) {
      const kids = children.get(cur)
      if (!kids || kids.length !== 1) break
      const onlyChild = kids[0]
      if (seen.has(onlyChild)) break
      const childKids = children.get(onlyChild)
      if (!childKids || childKids.length === 0) break
      parts.push(docs[onlyChild]?.title || onlyChild)
      seen.add(onlyChild)
      cur = onlyChild
    }
    return { label: parts.join('.'), terminalKey: cur }
  }

  function renderNode(key, depth, maxDepth, visited, displayTitle = null) {
    if (visited.has(key)) return ''
    visited.add(key)

    const info = docs[key]
    if (!info) return ''

    const kids = children.get(key)
    const isLeaf = !kids || kids.length === 0
    const filterKind = esc(info.role_heading || 'Other')
    const title = displayTitle || info.title || key

    if (isLeaf) {
      return `<li class="tree-leaf" data-filter-kind="${filterKind}" data-tree-key="${esc(key)}"><a href="${esc(info.href)}">${esc(title)}</a><span class="tree-meta">${esc(info.role_heading)}</span></li>`
    }

    let renderKey = key
    let renderTitle = title
    if (!displayTitle) {
      const { label, terminalKey } = compactChain(key)
      if (terminalKey !== key) {
        let cur = key
        while (cur !== terminalKey) {
          visited.add(cur)
          cur = children.get(cur)[0]
        }
        visited.add(terminalKey)
        renderKey = terminalKey
        renderTitle = label
      }
    }

    const renderInfo = docs[renderKey] || info
    const renderKids = children.get(renderKey)
    const desc = descendantCounts.get(renderKey) ?? 0
    const isOpen = depth < 2 ? ' open' : ''

    const overrides = renderKids ? disambiguateChildren(renderKey, renderKids) : new Map()

    let childHtml
    if (depth >= maxDepth) {
      childHtml = `<ul class="tree-children" data-lazy-parent="${esc(renderKey)}"></ul>`
    } else {
      const items = (renderKids || []).map(k => {
        const dt = overrides.get(k)
        return renderNode(k, depth + 1, maxDepth, visited, dt)
      }).join('\n')
      childHtml = `<ul class="tree-children">${items}</ul>`
    }

    return `<details class="tree-node" data-filter-kind="${filterKind}" data-tree-key="${esc(renderKey)}"${isOpen}>
  <summary><a href="${esc(renderInfo.href)}">${esc(renderTitle)}</a><span class="tree-meta">${esc(renderInfo.role_heading)}</span><span class="tree-count">${desc}</span></summary>
  ${childHtml}
</details>`
  }

  function expandLazy(parentKey) {
    const placeholder = treeContainer.querySelector(`[data-lazy-parent="${CSS.escape(parentKey)}"]`)
    if (!placeholder) return

    const kids = children.get(parentKey) || []
    const overrides = disambiguateChildren(parentKey, kids)
    const visited = new Set()
    visited.add(parentKey)
    const items = kids.map(k => {
      const displayTitle = overrides.get(k)
      return renderNode(k, 0, 2, visited, displayTitle)
    }).join('\n')

    placeholder.innerHTML = items
    placeholder.removeAttribute('data-lazy-parent')
  }

  treeContainer.addEventListener('toggle', (e) => {
    const details = e.target.closest('details.tree-node')
    if (!details || !details.open || !children) return
    const lazyUl = details.querySelector(':scope > ul[data-lazy-parent]')
    if (lazyUl) {
      expandLazy(lazyUl.getAttribute('data-lazy-parent'))
    }
  }, true)

  function ensureTreeBuilt() {
    if (treeBuilt || inflight) return
    inflight = true
    treeContainer.innerHTML = '<p class="loading">Loading tree…</p>'
    loadTreeData().then(data => {
      inflight = false
      if (!data) {
        treeContainer.innerHTML = '<p>Failed to load tree data.</p>'
        return
      }
      initTreeStateFrom(data)
      treeBuilt = true

      const parts = []
      parts.push(`<div class="tree-actions">
  <button id="tree-expand-all" type="button">Expand all</button>
  <button id="tree-collapse-all" type="button">Collapse all</button>
</div>`)

      const visited = new Set()
      for (const key of rootKeys) {
        parts.push(renderNode(key, 0, 2, visited))
      }
      // Orphans that have children but aren't reached from any root.
      for (const key of children.keys()) {
        if (!visited.has(key)) {
          parts.push(renderNode(key, 0, 2, visited))
        }
      }

      treeContainer.innerHTML = parts.join('\n')

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
            for (const el of batch) expandLazy(el.getAttribute('data-lazy-parent'))
            await new Promise(r => requestAnimationFrame(r))
          }
          const allDetails = [...treeContainer.querySelectorAll('details.tree-node')]
          for (let i = 0; i < allDetails.length; i += 100) {
            for (let j = i; j < Math.min(i + 100, allDetails.length); j++) {
              allDetails[j].open = true
            }
            await new Promise(r => requestAnimationFrame(r))
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

      applyTreeFilters()
    })
  }

  // ---- Integration with collection-filters ----
  function getActiveFilters() {
    const bar = document.querySelector('.collection-filter-bar')
    if (!bar) return new Set()
    const active = new Set()
    for (const chip of bar.querySelectorAll('.filter-chip.active')) {
      const val = chip.getAttribute('data-value')
      if (val) active.add(val)
    }
    return active
  }

  function applyTreeFilters() {
    if (!treeBuilt) return
    const active = getActiveFilters()
    const showAll = active.size === 0

    for (const el of treeContainer.querySelectorAll('[data-filter-kind]')) {
      const kind = el.getAttribute('data-filter-kind')
      el.style.display = (showAll || active.has(kind)) ? '' : 'none'
    }
  }

  const filterBar = document.querySelector('.collection-filter-bar')
  if (filterBar) {
    filterBar.addEventListener('click', () => {
      requestAnimationFrame(applyTreeFilters)
    })
  }

  // Tree is the default view — kick off the build (and the data load if
  // external) immediately.
  setViewMode('tree')
}
