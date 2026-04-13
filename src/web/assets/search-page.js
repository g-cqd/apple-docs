;(() => {
  const form = document.getElementById('search-form')
  const queryInput = document.getElementById('search-q')
  const statusEl = document.getElementById('search-status')
  const resultsEl = document.getElementById('search-results')
  const loadMoreBtn = document.getElementById('search-load-more')
  if (!form || !queryInput || !resultsEl) return

  const LIMIT = 50
  let currentOffset = 0
  let currentTotal = 0
  let currentResultCount = 0

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // Populate filter dropdowns from /api/filters
  async function loadFilters() {
    try {
      const resp = await fetch('/api/filters')
      if (!resp.ok) return
      const data = await resp.json()
      populateSelect('filter-framework', data.frameworks)
      populateSelect('filter-source', data.sources)
      populateSelect('filter-kind', data.kinds)
    } catch {
      // Filters unavailable (static mode) — dropdowns stay with "All" only
    }
  }

  function populateSelect(id, values) {
    const select = document.getElementById(id)
    if (!select || !values) return
    for (const val of values) {
      const opt = document.createElement('option')
      opt.value = val
      opt.textContent = val
      select.appendChild(opt)
    }
  }

  // Build search URL from form state
  function buildSearchUrl(offset) {
    const params = new URLSearchParams()
    const q = queryInput.value.trim()
    if (!q) return null
    params.set('q', q)
    params.set('limit', String(LIMIT))
    if (offset > 0) params.set('offset', String(offset))

    // Selects
    for (const name of ['framework', 'source', 'kind']) {
      const val = form.querySelector(`[name="${name}"]`)?.value
      if (val) params.set(name, val)
    }

    // Language radio
    const lang = form.querySelector('input[name="language"]:checked')?.value
    if (lang) params.set('language', lang)

    // Platform checkboxes — use first checked (API takes single value)
    const platforms = [...form.querySelectorAll('input[name="platform"]:checked')].map(el => el.value)
    if (platforms.length > 0) params.set('platform', platforms[0])

    // Text inputs
    for (const name of ['min_ios', 'min_macos', 'min_watchos', 'min_tvos', 'min_visionos', 'year', 'track']) {
      const el = form.querySelector(`[name="${name}"]`)
      if (el?.value) params.set(name, el.value)
    }

    // Checkboxes
    for (const name of ['no_fuzzy', 'no_deep']) {
      const el = form.querySelector(`[name="${name}"]`)
      if (el?.checked) params.set(name, '1')
    }

    return `/api/search?${params.toString()}`
  }

  // Sync form state to URL
  function pushState() {
    const params = new URLSearchParams()
    const q = queryInput.value.trim()
    if (q) params.set('q', q)
    for (const name of ['framework', 'source', 'kind']) {
      const val = form.querySelector(`[name="${name}"]`)?.value
      if (val) params.set(name, val)
    }
    const lang = form.querySelector('input[name="language"]:checked')?.value
    if (lang) params.set('language', lang)
    const platforms = [...form.querySelectorAll('input[name="platform"]:checked')].map(el => el.value)
    if (platforms.length > 0) params.set('platform', platforms.join(','))
    for (const name of ['min_ios', 'min_macos', 'min_watchos', 'min_tvos', 'min_visionos', 'year', 'track']) {
      const el = form.querySelector(`[name="${name}"]`)
      if (el?.value) params.set(name, el.value)
    }
    for (const name of ['no_fuzzy', 'no_deep']) {
      const el = form.querySelector(`[name="${name}"]`)
      if (el?.checked) params.set(name, '1')
    }
    const qs = params.toString()
    history.replaceState(null, '', qs ? `/search?${qs}` : '/search')
  }

  // Restore form state from URL
  function restoreFromUrl() {
    const params = new URLSearchParams(location.search)
    const q = params.get('q')
    if (q) queryInput.value = q
    for (const name of ['framework', 'source', 'kind']) {
      const el = form.querySelector(`[name="${name}"]`)
      const val = params.get(name)
      if (el && val) el.value = val
    }
    const lang = params.get('language')
    if (lang) {
      const radio = form.querySelector(`input[name="language"][value="${lang}"]`)
      if (radio) radio.checked = true
    }
    const platform = params.get('platform')
    if (platform) {
      for (const p of platform.split(',')) {
        const cb = form.querySelector(`input[name="platform"][value="${p}"]`)
        if (cb) cb.checked = true
      }
    }
    for (const name of ['min_ios', 'min_macos', 'min_watchos', 'min_tvos', 'min_visionos', 'year', 'track']) {
      const el = form.querySelector(`[name="${name}"]`)
      const val = params.get(name)
      if (el && val) el.value = val
    }
    for (const name of ['no_fuzzy', 'no_deep']) {
      const el = form.querySelector(`[name="${name}"]`)
      if (el && params.get(name) === '1') el.checked = true
    }
    return !!q
  }

  // Render results
  function renderResults(results, append) {
    const html = results.map(r => `
      <a href="/docs/${esc(r.path)}/" class="search-result-card">
        <div class="result-card-header">
          <span class="result-card-title">${esc(r.title)}</span>
          <span class="result-card-badges">
            ${r.framework ? `<span class="badge badge-framework">${esc(r.framework)}</span>` : ''}
            ${r.kind ? `<span class="badge badge-role">${esc(r.kind)}</span>` : ''}
            ${r.sourceType ? `<span class="badge badge-source">${esc(r.sourceType)}</span>` : ''}
          </span>
        </div>
        ${r.abstract ? `<p class="result-card-abstract">${esc(r.abstract)}</p>` : ''}
        ${r.snippet ? `<p class="result-card-snippet">${esc(r.snippet)}</p>` : ''}
        <div class="result-card-footer">
          ${r.matchQuality ? `<span class="result-card-quality">${esc(r.matchQuality)}</span>` : ''}
          ${r.relatedCount ? `<span class="result-card-related">${r.relatedCount} related</span>` : ''}
          ${r.language ? `<span class="result-card-lang">${esc(r.language)}</span>` : ''}
        </div>
      </a>
    `).join('')
    if (append) {
      resultsEl.insertAdjacentHTML('beforeend', html)
    } else {
      resultsEl.innerHTML = html
    }
  }

  // Perform search
  async function doSearch(offset) {
    const searchUrl = buildSearchUrl(offset)
    if (!searchUrl) {
      statusEl.hidden = true
      resultsEl.innerHTML = ''
      loadMoreBtn.hidden = true
      return
    }

    statusEl.textContent = 'Searching…'
    statusEl.hidden = false
    if (offset === 0) {
      resultsEl.innerHTML = ''
      loadMoreBtn.hidden = true
    }

    try {
      const resp = await fetch(searchUrl)
      if (!resp.ok) {
        statusEl.textContent = 'Search requires the live server. Run: apple-docs web serve'
        return
      }
      const data = await resp.json()
      const results = data.results ?? []
      currentTotal = data.total ?? 0

      if (offset === 0) {
        currentResultCount = results.length
        currentOffset = results.length
      } else {
        currentResultCount += results.length
        currentOffset += results.length
      }

      if (results.length === 0 && offset === 0) {
        statusEl.textContent = 'No results found.'
      } else {
        const intentLabel = data.intent?.type ? ` · ${data.intent.type}` : ''
        statusEl.textContent = `${currentTotal} results${intentLabel}`
      }

      renderResults(results, offset > 0)
      loadMoreBtn.hidden = currentResultCount >= currentTotal || results.length === 0
    } catch {
      statusEl.textContent = 'Search requires the live server. Run: apple-docs web serve'
    }
  }

  // Event handlers
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    pushState()
    doSearch(0)
  })

  loadMoreBtn.addEventListener('click', () => {
    doSearch(currentOffset)
  })

  // Initialize
  loadFilters().then(() => {
    if (restoreFromUrl()) {
      doSearch(0)
    }
  })
})()
