;(() => {
  const dataEl = document.getElementById('tree-data')
  if (!dataEl) return

  let treeData
  try {
    // The JSON is HTML-escaped in the attribute; the textContent gives us
    // the decoded value since the content is placed inside the tag as escaped text.
    const raw = dataEl.textContent || dataEl.innerText
    treeData = JSON.parse(raw)
  } catch {
    return
  }

  const { edges, docs } = treeData
  if (!edges || !docs) return

  const treeContainer = document.getElementById('tree-container')
  const listContainer = document.getElementById('list-container')
  if (!treeContainer || !listContainer) return

  const collectionControls = document.getElementById('collection-controls')

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

  // ---- Deferred list rendering ----
  // When the server skips rendering the list HTML (data-deferred), build it
  // client-side from the roleGroups data in the tree JSON.
  let listBuilt = !listContainer.hasAttribute('data-deferred')

  function ensureListBuilt() {
    if (listBuilt) return
    listBuilt = true
    listContainer.removeAttribute('data-deferred')

    const groups = treeData.roleGroups
    if (!groups || groups.length === 0) {
      listContainer.innerHTML = '<p>No documents found for this framework.</p>'
      return
    }

    const html = groups.map(group => {
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

    // Notify collection-filters that the list is now available
    document.dispatchEvent(new CustomEvent('list-container:ready'))
  }

  // ---- View toggle logic ----
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

  // ---- Tree data structures ----

  // Build adjacency list: parent -> [children]
  const children = new Map()
  const childSet = new Set()

  for (const { from_key, to_key } of edges) {
    if (!children.has(from_key)) children.set(from_key, [])
    children.get(from_key).push(to_key)
    childSet.add(to_key)
  }

  // Root nodes: appear as parent but never as child
  const allParents = new Set(children.keys())
  const rootKeys = []
  for (const key of allParents) {
    if (!childSet.has(key)) rootKeys.push(key)
  }

  // Also include docs that appear as children but have their own children
  // (they'll be reached through traversal)

  // Sort children alphabetically within each parent by title
  for (const [, kids] of children) {
    kids.sort((a, b) => {
      const ta = (docs[a]?.title ?? a).toLowerCase()
      const tb = (docs[b]?.title ?? b).toLowerCase()
      return ta < tb ? -1 : ta > tb ? 1 : 0
    })
  }

  // Sort root nodes alphabetically
  rootKeys.sort((a, b) => {
    const ta = (docs[a]?.title ?? a).toLowerCase()
    const tb = (docs[b]?.title ?? b).toLowerCase()
    return ta < tb ? -1 : ta > tb ? 1 : 0
  })

  // ---- Disambiguate overloads ----
  // Items that share the same title get a parent prefix for clarity
  function disambiguateChildren(parentKey, childKeys) {
    const titleCounts = new Map()
    for (const key of childKeys) {
      const t = docs[key]?.title ?? key
      titleCounts.set(t, (titleCounts.get(t) || 0) + 1)
    }
    // For duplicate titles, add the parent prefix
    const parentTitle = docs[parentKey]?.title ?? parentKey
    const result = new Map()
    for (const key of childKeys) {
      const t = docs[key]?.title ?? key
      if (titleCounts.get(t) > 1) {
        result.set(key, parentTitle + '.' + t)
      }
    }
    return result
  }

  // ---- Escape HTML ----
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // ---- Count all descendants (memoized) ----
  const descendantCounts = new Map()
  function computeDescendantCounts() {
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
  computeDescendantCounts()

  // ---- Chain compaction ----
  // Walk down single-child chains and return the compacted label + terminal key.
  // E.g. P256 -> Signing (only child) -> PrivateKey becomes "P256.Signing" with
  // the terminal key being the Signing node (which has multiple children).
  function compactChain(key) {
    const parts = [docs[key]?.title || key]
    let cur = key
    while (true) {
      const kids = children.get(cur)
      if (!kids || kids.length !== 1) break
      const onlyChild = kids[0]
      const childKids = children.get(onlyChild)
      // Only compact if the single child also has children (i.e., it's an intermediate node)
      if (!childKids || childKids.length === 0) break
      parts.push(docs[onlyChild]?.title || onlyChild)
      cur = onlyChild
    }
    return { label: parts.join('.'), terminalKey: cur }
  }

  // ---- Render a tree node ----
  // depth: current depth. maxDepth: how many levels to render eagerly.
  function renderNode(key, depth, maxDepth, visited, displayTitle = null) {
    if (visited.has(key)) return '' // cycle guard
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

    // Compact single-child chains (unless a display override was provided)
    let renderKey = key
    let renderTitle = title
    if (!displayTitle) {
      const { label, terminalKey } = compactChain(key)
      if (terminalKey !== key) {
        // Mark intermediate nodes as visited
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

    // Disambiguate children with identical titles
    const overrides = renderKids ? disambiguateChildren(renderKey, renderKids) : new Map()

    let childHtml
    if (depth >= maxDepth) {
      // Lazy placeholder
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

  // ---- Lazy expansion ----
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
    if (!details || !details.open) return
    const lazyUl = details.querySelector(':scope > ul[data-lazy-parent]')
    if (lazyUl) {
      expandLazy(lazyUl.getAttribute('data-lazy-parent'))
    }
  }, true)

  // ---- Build tree once ----
  let treeBuilt = false

  function ensureTreeBuilt() {
    if (treeBuilt) return
    treeBuilt = true

    const parts = []

    // Tree action buttons
    parts.push(`<div class="tree-actions">
  <button id="tree-expand-all" type="button">Expand all</button>
  <button id="tree-collapse-all" type="button">Collapse all</button>
</div>`)

    // Render root nodes
    const visited = new Set()
    for (const key of rootKeys) {
      parts.push(renderNode(key, 0, 2, visited))
    }

    // Also render orphan docs that have children but weren't reached
    // (in case some nodes only appear as from_key but not in rootKeys)
    for (const key of children.keys()) {
      if (!visited.has(key)) {
        parts.push(renderNode(key, 0, 2, visited))
      }
    }

    treeContainer.innerHTML = parts.join('\n')

    // Wire up expand/collapse all buttons
    const expandAllBtn = document.getElementById('tree-expand-all')
    const collapseAllBtn = document.getElementById('tree-collapse-all')

    if (expandAllBtn) {
      expandAllBtn.addEventListener('click', async () => {
        expandAllBtn.disabled = true
        expandAllBtn.textContent = 'Expanding…'
        // Expand lazy nodes in batches to avoid freezing the UI
        while (true) {
          const lazyEls = treeContainer.querySelectorAll('[data-lazy-parent]')
          if (lazyEls.length === 0) break
          const batch = [...lazyEls].slice(0, 20)
          for (const el of batch) expandLazy(el.getAttribute('data-lazy-parent'))
          await new Promise(r => requestAnimationFrame(r))
        }
        // Open all details in chunks
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

    // Apply current filters if any are active
    applyTreeFilters()
  }

  // ---- Integration with collection-filters ----
  // Listen for filter changes dispatched by collection-filters.js
  // We also poll the filter bar state since collection-filters.js doesn't emit events.
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

    // Show/hide tree items based on filter
    for (const el of treeContainer.querySelectorAll('[data-filter-kind]')) {
      const kind = el.getAttribute('data-filter-kind')
      if (showAll || active.has(kind)) {
        el.style.display = ''
      } else {
        el.style.display = 'none'
      }
    }
  }

  // Observe filter chip clicks
  const filterBar = document.querySelector('.collection-filter-bar')
  if (filterBar) {
    filterBar.addEventListener('click', () => {
      // Defer to let collection-filters.js update first
      requestAnimationFrame(applyTreeFilters)
    })
  }

  // Tree is the default view — build immediately and hide list controls
  setViewMode('tree')
})()
