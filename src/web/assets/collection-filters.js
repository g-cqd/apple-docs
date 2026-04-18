;(() => {
  // Find all elements with data-filter-kind.
  // When the list container is deferred (tree view default), there may be no
  // filterable items yet — we still need to initialise the filter UI so it's
  // ready when the list is built client-side.
  const listContainer = document.getElementById('list-container')
  const isDeferred = listContainer && listContainer.hasAttribute('data-deferred')

  let filterableItems = document.querySelectorAll('[data-filter-kind]')
  if (filterableItems.length === 0 && !isDeferred) return

  // Count distinct kinds from <li> items only (not group <section>s)
  // When deferred, pull counts from tree-data JSON instead
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

  if (kindCounts.size <= 1 && !isDeferred) return

  // Sort kinds alphabetically
  const sortedKinds = [...kindCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  // -----------------------------------------------------------------------
  // Controls container — inserted into #collection-controls if it exists,
  // otherwise falls back to inserting before first group
  // -----------------------------------------------------------------------

  const controlsHost = document.getElementById('collection-controls')

  // --- Quick search input ---
  const searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.className = 'framework-search'
  searchInput.placeholder = 'Filter symbols\u2026'
  searchInput.setAttribute('aria-label', 'Filter symbols in this framework')

  // --- Sort controls ---
  const sortControls = document.createElement('fieldset')
  sortControls.className = 'sort-controls'
  const sortLabel = document.createElement('legend')
  sortLabel.textContent = 'Sort by:'
  const sortSelect = document.createElement('select')
  sortSelect.id = 'sort-select'
  sortSelect.setAttribute('aria-label', 'Sort by')
  const optAlpha = document.createElement('option')
  optAlpha.value = 'alpha'
  optAlpha.textContent = 'Name (A\u2013Z)'
  const optKind = document.createElement('option')
  optKind.value = 'kind'
  optKind.textContent = 'Kind'
  sortSelect.appendChild(optAlpha)
  sortSelect.appendChild(optKind)
  sortControls.appendChild(sortLabel)
  sortControls.appendChild(sortSelect)

  // --- Deprecated toggle ---
  const deprecatedToggle = document.createElement('label')
  deprecatedToggle.className = 'deprecated-toggle'
  const deprecatedCb = document.createElement('input')
  deprecatedCb.type = 'checkbox'
  deprecatedCb.id = 'hide-deprecated'
  deprecatedToggle.appendChild(deprecatedCb)
  deprecatedToggle.appendChild(document.createTextNode(' Hide deprecated'))

  // --- Inline row for sort + deprecated toggle ---
  const inlineRow = document.createElement('div')
  inlineRow.className = 'collection-controls-row'
  inlineRow.appendChild(sortControls)
  inlineRow.appendChild(deprecatedToggle)

  // --- Build chip bar ---
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
    btn.innerHTML = esc(kind) + ' <span class="filter-chip-count">' + count + '</span>'
    bar.appendChild(btn)
  }

  // --- Insert controls ---
  if (controlsHost) {
    controlsHost.appendChild(searchInput)
    controlsHost.appendChild(inlineRow)
    controlsHost.appendChild(bar)
  } else {
    const firstGroup = document.querySelector('.framework-group, .role-group')
    if (firstGroup && firstGroup.parentNode) {
      firstGroup.parentNode.insertBefore(bar, firstGroup)
      firstGroup.parentNode.insertBefore(inlineRow, bar)
      firstGroup.parentNode.insertBefore(searchInput, inlineRow)
    }
  }

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  const activeFilters = new Set()
  let currentSort = 'alpha'
  let searchQuery = ''
  let hideDeprecated = false

  // -----------------------------------------------------------------------
  // Chip click handler
  // -----------------------------------------------------------------------

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-chip')
    if (!btn) return

    const value = btn.getAttribute('data-value')

    if (value === '') {
      activeFilters.clear()
      for (const chip of bar.querySelectorAll('.filter-chip')) {
        chip.classList.remove('active')
      }
      btn.classList.add('active')
    } else {
      allBtn.classList.remove('active')
      if (activeFilters.has(value)) {
        activeFilters.delete(value)
        btn.classList.remove('active')
      } else {
        activeFilters.add(value)
        btn.classList.add('active')
      }
      if (activeFilters.size === 0) {
        allBtn.classList.add('active')
      }
    }

    applyAll()
  })

  // -----------------------------------------------------------------------
  // Sort handler
  // -----------------------------------------------------------------------

  sortSelect.addEventListener('change', () => {
    currentSort = sortSelect.value
    applySort()
    applyAll()
  })

  function applySort() {
    const container = document.getElementById('list-container')
    if (!container) return

    const sections = [...container.querySelectorAll('.framework-group, .role-group')]
    if (sections.length === 0) return

    if (currentSort === 'kind') {
      // Re-group all <li> items by their data-filter-kind (role_heading)
      // Collect all LI elements from all sections
      const allLis = []
      for (const section of sections) {
        for (const li of section.querySelectorAll('li[data-filter-kind]')) {
          allLis.push(li)
        }
      }

      // Group by kind
      const byKind = new Map()
      for (const li of allLis) {
        const kind = li.getAttribute('data-filter-kind')
        if (!byKind.has(kind)) byKind.set(kind, [])
        byKind.get(kind).push(li)
      }

      // Sort kind groups alphabetically
      const sortedGroups = [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))

      // Remove existing sections
      for (const section of sections) {
        section.remove()
      }

      // Create new sections grouped by kind
      for (const [kind, lis] of sortedGroups) {
        const section = document.createElement('section')
        const kindSlug = slugify(kind)
        section.id = kindSlug
        section.className = 'role-group'
        section.setAttribute('data-filter-kind', kind)

        const heading = document.createElement('h2')
        heading.className = 'role-heading'
        heading.textContent = kind
        section.appendChild(heading)

        const ul = document.createElement('ul')
        ul.className = 'doc-list'

        // Sort LIs alphabetically within each kind group
        lis.sort((a, b) => {
          const aText = (a.querySelector('a')?.textContent ?? '').toLowerCase()
          const bText = (b.querySelector('a')?.textContent ?? '').toLowerCase()
          return aText.localeCompare(bText)
        })
        for (const li of lis) {
          ul.appendChild(li)
        }
        section.appendChild(ul)
        container.appendChild(section)
      }
    } else {
      // 'alpha' — restore original role-based grouping
      // We saved the original HTML on first load
      if (originalListHtml) {
        container.innerHTML = originalListHtml
      }
    }

    syncToc()
  }

  // -----------------------------------------------------------------------
  // Quick search handler
  // -----------------------------------------------------------------------

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase()
    applyAll()
  })

  // -----------------------------------------------------------------------
  // Deprecated toggle handler
  // -----------------------------------------------------------------------

  deprecatedCb.addEventListener('change', () => {
    hideDeprecated = deprecatedCb.checked
    applyAll()
  })

  // -----------------------------------------------------------------------
  // Unified apply (filters + search + deprecated)
  // -----------------------------------------------------------------------

  function applyAll() {
    const showAllKinds = activeFilters.size === 0

    // Get the current LI items (might be re-arranged by sort)
    const currentItems = document.querySelectorAll('.role-group li[data-filter-kind], .framework-group li[data-filter-kind]')

    for (const el of currentItems) {
      const kind = el.getAttribute('data-filter-kind')
      const isDeprecatedItem = el.getAttribute('data-deprecated') === 'true'
      const text = (el.textContent ?? '').toLowerCase()

      let visible = true

      // Kind filter
      if (!showAllKinds && !activeFilters.has(kind)) {
        visible = false
      }

      // Deprecated filter
      if (visible && hideDeprecated && isDeprecatedItem) {
        visible = false
      }

      // Search filter
      if (visible && searchQuery && !text.includes(searchQuery)) {
        visible = false
      }

      el.hidden = !visible
    }

    // Hide empty group sections
    for (const section of document.querySelectorAll('.framework-group, .role-group')) {
      const visibleItems = section.querySelectorAll('li:not([hidden])')
      section.hidden = visibleItems.length === 0
    }

    syncToc()
    updateHash()
  }

  // -----------------------------------------------------------------------
  // URL hash state
  // -----------------------------------------------------------------------

  function updateHash() {
    const params = []
    if (currentSort !== 'alpha') params.push('sort=' + currentSort)
    if (activeFilters.size > 0) params.push('filter=' + [...activeFilters].join(','))
    if (searchQuery) params.push('q=' + encodeURIComponent(searchQuery))
    if (hideDeprecated) params.push('hideDeprecated=1')

    if (params.length === 0) {
      history.replaceState(null, '', location.pathname + location.search)
    } else {
      history.replaceState(null, '', location.pathname + location.search + '#' + params.join('&'))
    }
  }

  function restoreFromHash() {
    const hash = location.hash
    if (!hash || hash.length < 2) return

    const raw = hash.slice(1)
    const pairs = raw.split('&')
    const map = new Map()
    for (const pair of pairs) {
      const idx = pair.indexOf('=')
      if (idx === -1) continue
      map.set(pair.slice(0, idx), pair.slice(idx + 1))
    }

    // Restore sort
    if (map.has('sort') && map.get('sort') === 'kind') {
      currentSort = 'kind'
      sortSelect.value = 'kind'
      applySort()
    }

    // Restore filters
    if (map.has('filter')) {
      const values = map.get('filter').split(',').filter(Boolean)
      for (const v of values) {
        if (kindCounts.has(v)) {
          activeFilters.add(v)
          const btn = bar.querySelector('[data-value="' + CSS.escape(v) + '"]')
          if (btn) btn.classList.add('active')
        }
      }
      if (activeFilters.size > 0) {
        allBtn.classList.remove('active')
      }
    }

    // Restore search
    if (map.has('q')) {
      try { searchQuery = decodeURIComponent(map.get('q')) } catch { searchQuery = map.get('q') }
      searchInput.value = searchQuery
    }

    // Restore deprecated toggle
    if (map.has('hideDeprecated') && map.get('hideDeprecated') === '1') {
      hideDeprecated = true
      deprecatedCb.checked = true
    }

    // Apply everything if any state was restored
    if (activeFilters.size > 0 || searchQuery || hideDeprecated) {
      applyAll()
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function slugify(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  }

  function syncToc() {
    const container = document.getElementById('list-container')
    if (!container) return

    const sections = [...container.children]
      .filter(el =>
        (el.classList.contains('framework-group') || el.classList.contains('role-group'))
        && !el.hidden
        && el.id,
      )
      .map(section => ({
        id: section.id,
        label: (section.querySelector('h2, .role-heading')?.textContent ?? section.id).trim(),
      }))

    const tocHtml = `<ul>${sections.map(section =>
      `<li><a href="#${esc(section.id)}">${esc(section.label)}</a></li>`
    ).join('')}</ul>`

    for (const toc of document.querySelectorAll('.page-toc')) {
      const mobileDetails = toc.closest('.page-toc-mobile')
      toc.hidden = sections.length < 2
      toc.innerHTML = tocHtml
      if (mobileDetails) {
        mobileDetails.hidden = sections.length < 2
      }
    }

    // Hide the TOC block when filtering leaves fewer than 2 sections.
    // If the TOC is the sidebar's only block, hide the whole sidebar too.
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

  // Save original HTML for restoring after sort-by-kind
  let originalListHtml = listContainer ? listContainer.innerHTML : null

  // When list is deferred, re-capture original HTML once the list is built
  if (isDeferred) {
    document.addEventListener('list-container:ready', () => {
      originalListHtml = listContainer ? listContainer.innerHTML : null
      restoreFromHash()
      syncToc()
    }, { once: true })
  }

  restoreFromHash()
  syncToc()
})()
