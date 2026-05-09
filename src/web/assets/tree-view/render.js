// Tree-view DOM rendering. Each helper takes the `state` object built
// in tree-view/state.js as its first argument so the render layer stays
// stateless — easier to reason about and easier to test if we ever
// build a JSDOM harness for these.

import { compactChain, disambiguateChildren } from './state.js'

export function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderNode(state, key, depth, maxDepth, visited, displayTitle = null) {
  if (visited.has(key)) return ''
  visited.add(key)

  const { docs, children, descendantCounts } = state
  const info = docs[key]
  if (!info) return ''

  const kids = children.get(key)
  const isLeaf = !kids || kids.length === 0
  const filterKind = escapeHtml(info.role_heading || 'Other')
  const title = displayTitle || info.title || key

  if (isLeaf) {
    return `<li class="tree-leaf" data-filter-kind="${filterKind}" data-tree-key="${escapeHtml(key)}"><a href="${escapeHtml(info.href)}">${escapeHtml(title)}</a><span class="tree-meta">${escapeHtml(info.role_heading)}</span></li>`
  }

  let renderKey = key
  let renderTitle = title
  if (!displayTitle) {
    const { label, terminalKey } = compactChain(state, key)
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

  const overrides = renderKids ? disambiguateChildren(state, renderKey, renderKids) : new Map()

  let childHtml
  if (depth >= maxDepth) {
    childHtml = `<ul class="tree-children" data-lazy-parent="${escapeHtml(renderKey)}"></ul>`
  } else {
    const items = (renderKids || []).map(k => {
      const dt = overrides.get(k)
      return renderNode(state, k, depth + 1, maxDepth, visited, dt)
    }).join('\n')
    childHtml = `<ul class="tree-children">${items}</ul>`
  }

  return `<details class="tree-node" data-filter-kind="${filterKind}" data-tree-key="${escapeHtml(renderKey)}"${isOpen}>
  <summary><a href="${escapeHtml(renderInfo.href)}">${escapeHtml(renderTitle)}</a><span class="tree-meta">${escapeHtml(renderInfo.role_heading)}</span><span class="tree-count">${desc}</span></summary>
  ${childHtml}
</details>`
}

export function expandLazy(state, treeContainer, parentKey) {
  const placeholder = treeContainer.querySelector(`[data-lazy-parent="${CSS.escape(parentKey)}"]`)
  if (!placeholder) return

  const kids = state.children.get(parentKey) || []
  const overrides = disambiguateChildren(state, parentKey, kids)
  const visited = new Set()
  visited.add(parentKey)
  const items = kids.map(k => {
    const displayTitle = overrides.get(k)
    return renderNode(state, k, 0, 2, visited, displayTitle)
  }).join('\n')

  placeholder.innerHTML = items
  placeholder.removeAttribute('data-lazy-parent')
}

// Read the active filter chips and hide tree nodes whose data-filter-kind
// isn't currently selected. Empty selection means "show everything".
export function applyTreeFilters(treeContainer) {
  const bar = document.querySelector('.collection-filter-bar')
  const active = new Set()
  if (bar) {
    for (const chip of bar.querySelectorAll('.filter-chip.active')) {
      const val = chip.getAttribute('data-value')
      if (val) active.add(val)
    }
  }
  const showAll = active.size === 0

  for (const el of treeContainer.querySelectorAll('[data-filter-kind]')) {
    const kind = el.getAttribute('data-filter-kind')
    el.style.display = (showAll || active.has(kind)) ? '' : 'none'
  }
}
