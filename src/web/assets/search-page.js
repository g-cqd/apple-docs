// Bun.build's `format: 'iife'` adds the outer scope shield in the
// minified output, so the source-level IIFE was redundant — `init()`
// is called explicitly by the bundle entry. Early-return bails
// (`if (!form) return`) stay intact because the body still lives
// inside a function.
function init() {
  const form = document.getElementById('search-form')
  const queryInput = document.getElementById('search-q')
  const statusEl = document.getElementById('search-status')
  const resultsEl = document.getElementById('search-results')
  const loadMoreBtn = document.getElementById('search-load-more')
  const submitBtn = form?.querySelector('button[type="submit"]')
  if (!form || !queryInput || !resultsEl) return

  const LIMIT = 50
  const defaultSubmitLabel = submitBtn?.textContent?.trim() || 'Search'
  const defaultLoadMoreLabel = loadMoreBtn?.textContent?.trim() || 'Load more results'
  let currentOffset = 0
  let currentTotal = 0
  let currentResultCount = 0
  let searchSeqId = 0
  let abortController = null

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
      populateSelect('filter-kind', data.kinds)
    } catch {
      // Filters unavailable (static mode) — dropdowns stay with "All" only
    }
  }

  function populateSelect(id, values) {
    const select = document.getElementById(id)
    if (!select || !values) return
    for (const val of values) {
      const value = typeof val === 'object' && val.value !== undefined ? val.value : val
      const label = typeof val === 'object' && val.value !== undefined ? (val.label ?? val.value) : val
      const existing = [...select.options].find(option => option.value === value)
      if (existing) {
        if (existing.textContent === existing.value) existing.textContent = label
        continue
      }
      const opt = document.createElement('option')
      opt.value = value
      opt.textContent = label
      select.appendChild(opt)
    }
  }

  function ensureSelectOption(select, value) {
    if (!select || !value) return
    if ([...select.options].some(option => option.value === value)) return
    const opt = document.createElement('option')
    opt.value = value
    opt.textContent = value
    select.appendChild(opt)
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
    for (const name of ['framework', 'kind']) {
      const val = form.querySelector(`[name="${name}"]`)?.value
      if (val) params.set(name, val)
    }

    // Language radio
    const lang = form.querySelector('input[name="language"]:checked')?.value
    if (lang) params.set('language', lang)

    // Platform checkboxes — send comma-joined list
    const platforms = [...form.querySelectorAll('input[name="platform"]:checked')].map(el => el.value)
    if (platforms.length > 0) params.set('platform', platforms.join(','))

    // Text inputs
    for (const name of ['min_ios', 'min_macos', 'min_watchos', 'min_tvos', 'min_visionos', 'year', 'track']) {
      const el = form.querySelector(`[name="${name}"]`)
      if (el?.value) params.set(name, el.value)
    }

    // Checkboxes
    for (const name of ['fuzzy', 'deep']) {
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
    for (const name of ['framework', 'kind']) {
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
    for (const name of ['fuzzy', 'deep']) {
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
    for (const name of ['framework', 'kind']) {
      const el = form.querySelector(`[name="${name}"]`)
      const val = params.get(name)
      if (el && val) {
        if (el.tagName === 'SELECT') ensureSelectOption(el, val)
        el.value = val
      }
    }
    const lang = params.get('language')
    if (lang) {
      const radio = form.querySelector(`input[name="language"][value="${CSS.escape(lang)}"]`)
      if (radio) radio.checked = true
    }
    const platform = params.get('platform')
    if (platform) {
      for (const p of platform.split(',')) {
        const cb = form.querySelector(`input[name="platform"][value="${CSS.escape(p)}"]`)
        if (cb) cb.checked = true
      }
    }
    for (const name of ['min_ios', 'min_macos', 'min_watchos', 'min_tvos', 'min_visionos', 'year', 'track']) {
      const el = form.querySelector(`[name="${name}"]`)
      const val = params.get(name)
      if (el && val) el.value = val
    }
    for (const name of ['fuzzy', 'deep', 'no_fuzzy', 'no_deep']) {
      const el = form.querySelector(`[name="${name}"]`)
      if (el && params.get(name) === '1') el.checked = true
    }
    return !!q
  }

  // Coalesce the three relaxed subtypes into a single user-facing label while
  // preserving the original subtype on a data attribute for analytics.
  function displayQuality(quality) {
    if (!quality) return null
    if (quality === 'relaxed' || quality === 'relaxed-or' || quality === 'relaxed-token') return 'relaxed'
    return quality
  }

  // Render results
  function renderResults(results, append) {
    const html = results.map(r => {
      const label = displayQuality(r.matchQuality)
      const qualityHtml = label
        ? `<span class="result-card-quality" data-relaxation-tier="${esc(r.matchQuality)}">${esc(label)}</span>`
        : ''
      return `
      <a href="/docs/${esc(r.path)}/" class="search-result-card">
        <div class="result-card-header">
          <span class="result-card-title">${esc(r.title)}</span>
          <span class="result-card-badges">
            ${r.framework ? `<span class="badge badge-framework">${esc(r.framework)}</span>` : ''}
            ${r.kind ? `<span class="badge badge-role">${esc(r.kind)}</span>` : ''}
          </span>
        </div>
        ${r.abstract ? `<p class="result-card-abstract">${esc(r.abstract)}</p>` : ''}
        ${r.snippet ? `<p class="result-card-snippet">${esc(r.snippet)}</p>` : ''}
        <div class="result-card-footer">
          ${qualityHtml}
          ${r.relatedCount ? `<span class="result-card-related">${r.relatedCount} related</span>` : ''}
          ${r.language ? `<span class="result-card-lang">${esc(r.language)}</span>` : ''}
        </div>
      </a>
    `
    }).join('')
    if (append) {
      resultsEl.insertAdjacentHTML('beforeend', html)
    } else {
      resultsEl.innerHTML = html
    }
  }

  function renderLoadingState(message, keepResults) {
    statusEl.textContent = message
    statusEl.hidden = false
    resultsEl.classList.add('is-loading')
    resultsEl.setAttribute('aria-busy', 'true')
    if (!keepResults) {
      resultsEl.innerHTML = `<div class="search-result-placeholder" role="status">${esc(message)}</div>`
    }
  }

  function resetLoadingState() {
    resultsEl.classList.remove('is-loading')
    resultsEl.setAttribute('aria-busy', 'false')
    if (submitBtn) {
      submitBtn.disabled = false
      submitBtn.textContent = defaultSubmitLabel
    }
    if (loadMoreBtn) {
      loadMoreBtn.disabled = false
      loadMoreBtn.textContent = defaultLoadMoreLabel
    }
  }

  // Perform search
  async function doSearch(offset, { preserveResults = false } = {}) {
    const searchUrl = buildSearchUrl(offset)
    if (!searchUrl) {
      if (abortController) abortController.abort()
      searchSeqId++
      statusEl.hidden = true
      resultsEl.innerHTML = ''
      resultsEl.classList.remove('is-loading')
      resultsEl.setAttribute('aria-busy', 'false')
      loadMoreBtn.hidden = true
      currentOffset = 0
      currentTotal = 0
      currentResultCount = 0
      resetLoadingState()
      return
    }

    const seqId = ++searchSeqId
    if (abortController) abortController.abort()
    abortController = new AbortController()

    const keepResults = offset > 0 || (preserveResults && currentResultCount > 0)
    renderLoadingState(offset > 0 ? 'Loading more results…' : 'Searching…', keepResults)
    if (submitBtn && offset === 0) {
      submitBtn.disabled = true
      submitBtn.textContent = 'Searching…'
    }
    loadMoreBtn.disabled = true
    if (offset > 0) {
      loadMoreBtn.hidden = false
      loadMoreBtn.textContent = 'Loading…'
    } else if (!keepResults) {
      loadMoreBtn.hidden = true
    }

    try {
      const resp = await fetch(searchUrl, { signal: abortController.signal })
      if (seqId !== searchSeqId) return
      if (!resp.ok) {
        statusEl.textContent = 'Search requires the live server. Run: apple-docs web serve'
        if (!keepResults) resultsEl.innerHTML = ''
        loadMoreBtn.hidden = true
        return
      }
      const data = await resp.json()
      if (seqId !== searchSeqId) return
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
        resultsEl.innerHTML = ''
      } else {
        const intentLabel = data.intent?.type ? ` · ${data.intent.type}` : ''
        const relaxedLabel = data.relaxed ? ' · best-effort (query relaxed)' : ''
        statusEl.textContent = `${currentTotal} results${intentLabel}${relaxedLabel}`
        renderResults(results, offset > 0)
      }

      loadMoreBtn.hidden = currentResultCount >= currentTotal || results.length === 0
    } catch (error) {
      if (error?.name === 'AbortError') return
      statusEl.textContent = 'Search requires the live server. Run: apple-docs web serve'
      if (!keepResults) resultsEl.innerHTML = ''
      loadMoreBtn.hidden = true
    } finally {
      if (seqId === searchSeqId) resetLoadingState()
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

  window.addEventListener('popstate', () => {
    restoreFromUrl()
    doSearch(0)
  })

  // Auto-search when filters change
  form.addEventListener('change', (e) => {
    if (e.target === queryInput) return
    pushState()
    doSearch(0)
  })

  // Initialize
  const hasInitialQuery = restoreFromUrl()
  loadFilters()
  if (hasInitialQuery) {
    doSearch(0)
  }
}

init()
