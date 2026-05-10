// Header quick-search controller. Debounces /api/search calls, renders
// the dropdown of hits, handles keyboard navigation (arrow keys, Enter,
// Escape, `/` shortcut), and announces result counts via an aria-live
// region.
//
// All state and helpers stay inside `init()` so the bundled output keeps
// a closed scope without an explicit IIFE wrapper.
export function init() {
  const input = document.querySelector('.search-input')
  const dropdown = document.querySelector('.search-dropdown')
  const clearBtn = document.querySelector('.search-clear')
  const statusEl = document.getElementById('header-search-status')
  if (!input || !dropdown) return

  let debounceTimer = null
  let activeIndex = -1
  let _currentResults = []
  let _currentQuery = ''
  let _searchSeqId = 0
  let _abortController = null

  // Debounce helper
  function debounce(fn, ms) {
    return (...args) => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => fn(...args), ms)
    }
  }

  // Escape HTML for safe rendering
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // Highlight matching portions of text with <mark> elements
  function highlightMatch(text, query) {
    if (!query || !text) return esc(text)
    const escaped = esc(text)
    const queryEscaped = esc(query)
    const safeQuery = queryEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${safeQuery})`, 'gi')
    return escaped.replace(regex, '<mark>$1</mark>')
  }

  // Update the ARIA expanded state
  function setExpanded(expanded) {
    input.setAttribute('aria-expanded', String(expanded))
  }

  // Update the clear button visibility
  function updateClearButton() {
    if (clearBtn) {
      clearBtn.hidden = input.value.length === 0
    }
  }

  // Announce status to screen readers
  function announce(message) {
    if (statusEl) {
      statusEl.textContent = message
    }
  }

  // Show the dropdown
  function showDropdown() {
    dropdown.setAttribute('role', 'listbox')
    dropdown.hidden = false
    setExpanded(true)
  }

  // Hide the dropdown
  function hideDropdown() {
    dropdown.removeAttribute('role')
    dropdown.hidden = true
    setExpanded(false)
    input.setAttribute('aria-activedescendant', '')
    activeIndex = -1
  }

  // Handle input — uses /api/search (same engine as CLI)
  const onInput = debounce(async () => {
    const query = input.value.trim()
    updateClearButton()
    if (query.length < 2) {
      hideDropdown()
      _currentResults = []
      _currentQuery = ''
      announce('')
      return
    }
    _currentQuery = query
    const seqId = ++_searchSeqId

    // Abort any in-flight request
    if (_abortController) _abortController.abort()
    _abortController = new AbortController()

    // Show loading indicator
    dropdown.innerHTML = '<div class="search-loading" role="option" id="search-result-loading">Searching\u2026</div>'
    showDropdown()

    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=10&no_deep=1&no_eager=1`, {
        signal: _abortController.signal,
      })
      if (seqId !== _searchSeqId) return // stale
      const data = await resp.json()
      _currentResults = data.results || []
      renderResults(_currentResults, query)
    } catch (e) {
      if (e.name !== 'AbortError') {
        renderResults([], query)
      }
    }
  }, 200)

  input.addEventListener('input', onInput)

  function renderResults(hits, query) {
    activeIndex = -1
    input.setAttribute('aria-activedescendant', '')

    if (hits.length === 0) {
      dropdown.innerHTML = '<div class="no-results" role="option" id="search-result-none">No results found</div>'
      showDropdown()
      announce(`No results for ${query}`)
      return
    }
    dropdown.innerHTML = hits
      .map(
        (hit, i) => `
      <a href="/docs/${esc(hit.path)}/" class="search-result" role="option" id="search-result-${i}" data-index="${i}" aria-selected="false">
        <span class="result-title">${highlightMatch(hit.title, query)}</span>
        <span class="result-meta">${esc(hit.framework || '')}${hit.kind ? ` · ${esc(hit.kind)}` : ''}</span>
        ${hit.abstract ? `<span class="result-snippet">${esc(hit.abstract)}</span>` : ''}
      </a>
    `,
      )
      .join('') + `<a href="/search?q=${encodeURIComponent(query || '')}" class="search-view-all" role="option" id="search-result-viewall">View all results &rarr;</a>`
    showDropdown()

    const count = hits.length
    announce(`${count} result${count === 1 ? '' : 's'} found`)
  }

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.search-result, .search-view-all')
    if (items.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      activeIndex = Math.min(activeIndex + 1, items.length - 1)
      updateActive(items)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      activeIndex = Math.max(activeIndex - 1, -1)
      updateActive(items)
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      items[activeIndex].click()
    } else if (e.key === 'Escape') {
      hideDropdown()
    }
  })

  function updateActive(items) {
    items.forEach((item, i) => {
      const isActive = i === activeIndex
      item.classList.toggle('active', isActive)
      item.setAttribute('aria-selected', String(isActive))
    })
    if (activeIndex >= 0) {
      const activeId = items[activeIndex].id
      input.setAttribute('aria-activedescendant', activeId)
      items[activeIndex].scrollIntoView({ block: 'nearest' })
    } else {
      input.setAttribute('aria-activedescendant', '')
    }
  }

  // Clear button handler
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = ''
      _currentResults = []
      _currentQuery = ''
      hideDropdown()
      updateClearButton()
      announce('')
      input.focus()
    })
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      hideDropdown()
    }
  })

  // Focus search with / key
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      input.focus()
    }
  })

  // Initialize clear button state
  updateClearButton()
}
