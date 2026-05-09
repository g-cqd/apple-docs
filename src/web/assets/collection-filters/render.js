// Collection-filter DOM rendering. The controller composes these into
// the page; each function takes only what it needs (no module-level
// state).

import { escapeHtml, slugify } from './state.js'

/**
 * Build every control the user interacts with: the chip bar, the quick
 * search input, the sort dropdown, the "hide deprecated" toggle. Returns
 * the elements so the controller can wire events onto them.
 */
export function buildControls(sortedKinds) {
  const searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.className = 'framework-search'
  searchInput.placeholder = 'Filter symbols…'
  searchInput.setAttribute('aria-label', 'Filter symbols in this framework')

  const sortControls = document.createElement('fieldset')
  sortControls.className = 'sort-controls'
  const sortLabel = document.createElement('legend')
  sortLabel.textContent = 'Sort by:'
  const sortSelect = document.createElement('select')
  sortSelect.id = 'sort-select'
  sortSelect.setAttribute('aria-label', 'Sort by')
  for (const [value, label] of [['alpha', 'Name (A–Z)'], ['kind', 'Kind']]) {
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = label
    sortSelect.appendChild(opt)
  }
  sortControls.appendChild(sortLabel)
  sortControls.appendChild(sortSelect)

  const deprecatedToggle = document.createElement('label')
  deprecatedToggle.className = 'deprecated-toggle'
  const deprecatedCb = document.createElement('input')
  deprecatedCb.type = 'checkbox'
  deprecatedCb.id = 'hide-deprecated'
  deprecatedToggle.appendChild(deprecatedCb)
  deprecatedToggle.appendChild(document.createTextNode(' Hide deprecated'))

  const inlineRow = document.createElement('div')
  inlineRow.className = 'collection-controls-row'
  inlineRow.appendChild(sortControls)
  inlineRow.appendChild(deprecatedToggle)

  const bar = document.createElement('div')
  bar.className = 'collection-filter-bar'
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', 'Filter by type')

  const allBtn = document.createElement('button')
  allBtn.className = 'filter-chip active'
  allBtn.setAttribute('data-value', '')
  allBtn.textContent = 'All'
  bar.appendChild(allBtn)

  for (const [kind, count] of sortedKinds) {
    const btn = document.createElement('button')
    btn.className = 'filter-chip'
    btn.setAttribute('data-value', kind)
    btn.setAttribute('aria-label', `Filter by ${kind} (${count})`)
    btn.innerHTML = `${escapeHtml(kind)} <span class="filter-chip-count">${count}</span>`
    bar.appendChild(btn)
  }

  return { searchInput, sortSelect, deprecatedCb, bar, allBtn, inlineRow }
}

export function insertControls({ controls, controlsHost }) {
  const { searchInput, inlineRow, bar } = controls
  if (controlsHost) {
    controlsHost.appendChild(searchInput)
    controlsHost.appendChild(inlineRow)
    controlsHost.appendChild(bar)
    return
  }
  const firstGroup = document.querySelector('.framework-group, .role-group')
  if (firstGroup && firstGroup.parentNode) {
    firstGroup.parentNode.insertBefore(bar, firstGroup)
    firstGroup.parentNode.insertBefore(inlineRow, bar)
    firstGroup.parentNode.insertBefore(searchInput, inlineRow)
  }
}

/**
 * Re-flow the list according to the current sort.
 *   - 'alpha': restore the original server-rendered HTML (role-grouped).
 *   - 'kind' : flatten every <li> under data-filter-kind into new
 *              alphabetically-sorted role groups.
 *
 * @param {{ currentSort: string }} state
 * @param {string|null} originalListHtml — captured before the first
 *        kind-sort so we can restore the canonical layout.
 */
export function applySort(state, originalListHtml) {
  const container = document.getElementById('list-container')
  if (!container) return
  const sections = [...container.querySelectorAll('.framework-group, .role-group')]
  if (sections.length === 0) return

  if (state.currentSort === 'kind') {
    const allLis = []
    for (const section of sections) {
      for (const li of section.querySelectorAll('li[data-filter-kind]')) {
        allLis.push(li)
      }
    }
    const byKind = new Map()
    for (const li of allLis) {
      const kind = li.getAttribute('data-filter-kind')
      if (!byKind.has(kind)) byKind.set(kind, [])
      byKind.get(kind).push(li)
    }
    const sortedGroups = [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const section of sections) section.remove()

    for (const [kind, lis] of sortedGroups) {
      const section = document.createElement('section')
      section.id = slugify(kind)
      section.className = 'role-group'
      section.setAttribute('data-filter-kind', kind)
      const heading = document.createElement('h2')
      heading.className = 'role-heading'
      heading.textContent = kind
      section.appendChild(heading)
      const ul = document.createElement('ul')
      ul.className = 'doc-list'
      lis.sort((a, b) => {
        const aText = (a.querySelector('a')?.textContent ?? '').toLowerCase()
        const bText = (b.querySelector('a')?.textContent ?? '').toLowerCase()
        return aText.localeCompare(bText)
      })
      for (const li of lis) ul.appendChild(li)
      section.appendChild(ul)
      container.appendChild(section)
    }
  } else if (originalListHtml) {
    container.innerHTML = originalListHtml
  }
}

/** Apply kind/search/deprecated filters to the currently-rendered list. */
export function applyFilters(state) {
  const showAllKinds = state.activeFilters.size === 0
  const items = document.querySelectorAll(
    '.role-group li[data-filter-kind], .framework-group li[data-filter-kind]',
  )
  for (const el of items) {
    const kind = el.getAttribute('data-filter-kind')
    const isDeprecated = el.getAttribute('data-deprecated') === 'true'
    const text = (el.textContent ?? '').toLowerCase()
    let visible = true
    if (!showAllKinds && !state.activeFilters.has(kind)) visible = false
    if (visible && state.hideDeprecated && isDeprecated) visible = false
    if (visible && state.searchQuery && !text.includes(state.searchQuery)) visible = false
    el.hidden = !visible
  }
  for (const section of document.querySelectorAll('.framework-group, .role-group')) {
    const visibleItems = section.querySelectorAll('li:not([hidden])')
    section.hidden = visibleItems.length === 0
  }
}

/** Sync the page-TOC links to the currently visible group sections. */
export function syncToc() {
  const container = document.getElementById('list-container')
  if (!container) return
  const sections = [...container.children]
    .filter(el =>
      (el.classList.contains('framework-group') || el.classList.contains('role-group'))
      && !el.hidden && el.id,
    )
    .map(section => ({
      id: section.id,
      label: (section.querySelector('h2, .role-heading')?.textContent ?? section.id).trim(),
    }))

  const tocHtml = `<ul>${sections.map(section =>
    `<li><a href="#${escapeHtml(section.id)}">${escapeHtml(section.label)}</a></li>`,
  ).join('')}</ul>`

  for (const toc of document.querySelectorAll('.page-toc')) {
    const mobileDetails = toc.closest('.page-toc-mobile')
    toc.hidden = sections.length < 2
    toc.innerHTML = tocHtml
    if (mobileDetails) mobileDetails.hidden = sections.length < 2
  }

  // Hide the TOC sidebar block if it's the only block left and there's
  // not enough to show.
  const sidebar = document.querySelector('.doc-sidebar')
  const mainContent = document.querySelector('.main-content')
  if (sidebar) {
    const tocBlock = sidebar.querySelector('.sidebar-block:has(> .page-toc)')
    if (tocBlock) tocBlock.hidden = sections.length < 2
    const visibleBlocks = Array.from(sidebar.querySelectorAll(':scope > .sidebar-block')).filter(el => !el.hidden)
    const hasSidebarVisible = visibleBlocks.length > 0
    sidebar.hidden = !hasSidebarVisible
    if (mainContent) mainContent.classList.toggle('has-sidebar', hasSidebarVisible)
  }

  document.dispatchEvent(new CustomEvent('page-toc:refresh'))
}
