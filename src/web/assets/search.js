;(() => {
  const worker = new Worker('/worker/search-worker.js')
  const input = document.querySelector('.search-input')
  const dropdown = document.querySelector('.search-dropdown')
  if (!input || !dropdown) return

  let debounceTimer = null
  let activeIndex = -1
  let _currentResults = []

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

  // Handle input
  const onInput = debounce(() => {
    const query = input.value.trim()
    if (query.length < 2) {
      dropdown.hidden = true
      _currentResults = []
      return
    }
    worker.postMessage({ type: 'search', query, limit: 10 })
  }, 150)

  input.addEventListener('input', onInput)

  // Handle worker results
  worker.addEventListener('message', (event) => {
    const { type, results, query } = event.data
    if (type === 'results') {
      _currentResults = results
      renderResults(results, query)
    }
  })

  function renderResults(hits, _query) {
    activeIndex = -1
    if (hits.length === 0) {
      dropdown.innerHTML = '<div class="no-results">No results found</div>'
      dropdown.hidden = false
      return
    }
    dropdown.innerHTML = hits
      .map(
        (hit, i) => `
      <a href="/docs/${esc(hit.key)}/" class="search-result" data-index="${i}">
        <span class="result-title">${esc(hit.title)}</span>
        <span class="result-meta">${esc(hit.framework || '')}${hit.kind ? ` · ${esc(hit.kind)}` : ''}</span>
        ${hit.abstract ? `<span class="result-snippet">${esc(hit.abstract)}</span>` : ''}
      </a>
    `,
      )
      .join('') + `<a href="/search?q=${encodeURIComponent(_query || '')}" class="search-view-all">View all results &rarr;</a>`
    dropdown.hidden = false
  }

  // Keyboard navigation
  input.addEventListener('keydown', (e) => {
    const items = dropdown.querySelectorAll('.search-result')
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
      dropdown.hidden = true
      activeIndex = -1
    }
  })

  function updateActive(items) {
    items.forEach((item, i) => {
      item.classList.toggle('active', i === activeIndex)
    })
    if (activeIndex >= 0) items[activeIndex].scrollIntoView({ block: 'nearest' })
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      dropdown.hidden = true
    }
  })

  // Focus search with / key
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      input.focus()
    }
  })

  // Init worker
  worker.postMessage({ type: 'init' })
})()
