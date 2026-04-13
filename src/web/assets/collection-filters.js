;(() => {
  // Find all elements with data-filter-kind
  const filterableItems = document.querySelectorAll('[data-filter-kind]')
  if (filterableItems.length === 0) return

  // Count distinct kinds from <li> items only (not group <section>s)
  const kindCounts = new Map()
  for (const el of filterableItems) {
    if (el.tagName !== 'LI') continue
    const kind = el.getAttribute('data-filter-kind')
    kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1)
  }

  if (kindCounts.size <= 1) return

  // Sort kinds alphabetically
  const sortedKinds = [...kindCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  // Build chip bar
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
    btn.innerHTML = esc(kind) + ' <span class="filter-chip-count">' + count + '</span>'
    bar.appendChild(btn)
  }

  // Insert before the first filterable group
  const firstGroup = document.querySelector('.framework-group, .role-group')
  if (firstGroup && firstGroup.parentNode) {
    firstGroup.parentNode.insertBefore(bar, firstGroup)
  }

  // Active filters (multi-select OR logic)
  const activeFilters = new Set()

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

    applyFilters()
    updateHash()
  })

  function applyFilters() {
    const showAll = activeFilters.size === 0

    // Show/hide individual items
    for (const el of filterableItems) {
      if (el.tagName !== 'LI') continue
      const kind = el.getAttribute('data-filter-kind')
      el.hidden = !showAll && !activeFilters.has(kind)
    }

    // Hide empty group sections
    for (const section of document.querySelectorAll('.framework-group, .role-group')) {
      const visibleItems = section.querySelectorAll('li:not([hidden])')
      section.hidden = visibleItems.length === 0
    }
  }

  function updateHash() {
    if (activeFilters.size === 0) {
      history.replaceState(null, '', location.pathname + location.search)
    } else {
      history.replaceState(null, '', location.pathname + location.search + '#filter=' + [...activeFilters].join(','))
    }
  }

  function restoreFromHash() {
    const hash = location.hash
    if (!hash.startsWith('#filter=')) return
    const values = hash.slice(8).split(',').filter(Boolean)
    for (const v of values) {
      if (kindCounts.has(v)) {
        activeFilters.add(v)
        const btn = bar.querySelector('[data-value="' + CSS.escape(v) + '"]')
        if (btn) btn.classList.add('active')
      }
    }
    if (activeFilters.size > 0) {
      allBtn.classList.remove('active')
      applyFilters()
    }
  }

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  restoreFromHash()
})()
