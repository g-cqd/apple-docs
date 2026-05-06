// Symbols page — virtualized lazy grid + drawer detail pane.
//
// Loads the full symbol catalog once (gzipped JSON, ETag cached). Renders the
// visible row range using absolute positioning so the DOM stays small even
// with ~10k entries. Tile icons use CSS mask-image so they automatically
// take the current theme's text color. Clicking a tile opens a drawer with
// metadata + customisable render that drives the SVG/PNG download URLs.

(function () {
  const scroller = document.getElementById('symbols-scroller')
  const spacer = document.getElementById('symbols-spacer')
  const viewport = document.getElementById('symbols-viewport')
  const queryInput = document.getElementById('symbols-q')
  const scopeSelect = document.getElementById('symbols-scope')
  const statusEl = document.getElementById('symbols-status')
  const countEl = document.getElementById('symbols-count')
  if (!scroller || !spacer || !viewport) return

  const TILE_SIZE = 96
  const TILE_GAP = 8
  const OVERSCAN_ROWS = 4

  const detail = {
    root: document.getElementById('symbols-detail'),
    closeBtn: document.getElementById('symbols-detail-close'),
    preview: document.getElementById('symbols-detail-preview'),
    name: document.getElementById('symbols-detail-name'),
    scope: document.getElementById('symbols-detail-scope'),
    size: document.getElementById('symbols-detail-size'),
    sizeValue: document.getElementById('symbols-detail-size-value'),
    fg: document.getElementById('symbols-detail-fg'),
    fgHex: document.getElementById('symbols-detail-fg-hex'),
    bg: document.getElementById('symbols-detail-bg'),
    bgHex: document.getElementById('symbols-detail-bg-hex'),
    bgTransparent: document.getElementById('symbols-detail-bg-transparent'),
    downloadSvg: document.getElementById('symbols-detail-download-svg'),
    downloadPng: document.getElementById('symbols-detail-download-png'),
    meta: document.getElementById('symbols-detail-meta'),
  }

  let allSymbols = []
  let filtered = []
  let columns = computeColumns()
  let lastClickedTile = null
  let activeSymbol = null

  status('Loading symbols…')
  fetch('/api/symbols/index.json', { credentials: 'same-origin' })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    })
    .then(data => {
      allSymbols = Array.isArray(data.symbols) ? data.symbols : []
      if (countEl) countEl.textContent = allSymbols.length.toLocaleString('en-US')
      applyFilters()
    })
    .catch(error => {
      status(`Unable to load symbols: ${error.message}`)
    })

  scroller.addEventListener('scroll', requestRender, { passive: true })
  window.addEventListener('resize', () => {
    columns = computeColumns()
    layout()
  })

  let filterTimer = 0
  queryInput?.addEventListener('input', () => {
    clearTimeout(filterTimer)
    filterTimer = setTimeout(applyFilters, 50)
  })
  scopeSelect?.addEventListener('change', applyFilters)

  detail.closeBtn?.addEventListener('click', closeDetail)
  scroller.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeDetail()
  })

  detail.size.addEventListener('input', () => {
    detail.sizeValue.textContent = detail.size.value
    refreshDetailPreview()
  })
  bindColorPair(detail.fg, detail.fgHex, refreshDetailPreview)
  bindColorPair(detail.bg, detail.bgHex, () => {
    if (detail.bgHex.value) detail.bgTransparent.checked = false
    refreshDetailPreview()
  })
  detail.bgTransparent.addEventListener('change', () => {
    if (detail.bgTransparent.checked) detail.bgHex.value = ''
    refreshDetailPreview()
  })

  function applyFilters() {
    const q = (queryInput?.value ?? '').trim().toLowerCase()
    const scope = scopeSelect?.value ?? ''
    if (!q && !scope) {
      filtered = allSymbols
    } else {
      filtered = allSymbols.filter(symbol => {
        if (scope && symbol.scope !== scope) return false
        if (!q) return true
        if (symbol.name.toLowerCase().includes(q)) return true
        if (symbol.categories.some(value => value.toLowerCase().includes(q))) return true
        if (symbol.keywords.some(value => value.toLowerCase().includes(q))) return true
        return false
      })
    }
    status(`${filtered.length.toLocaleString('en-US')} matching symbol${filtered.length === 1 ? '' : 's'}`)
    layout()
    scroller.scrollTop = 0
    requestRender()
  }

  function computeColumns() {
    const width = scroller.clientWidth || 800
    const tile = TILE_SIZE + TILE_GAP
    return Math.max(1, Math.floor((width - TILE_GAP) / tile))
  }

  function layout() {
    columns = computeColumns()
    const rows = Math.ceil(filtered.length / columns)
    const totalHeight = rows * (TILE_SIZE + TILE_GAP) + TILE_GAP
    spacer.style.height = `${totalHeight}px`
  }

  let renderQueued = false
  function requestRender() {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(() => {
      renderQueued = false
      render()
    })
  }

  function render() {
    if (!filtered.length) {
      viewport.replaceChildren()
      return
    }
    const tile = TILE_SIZE + TILE_GAP
    const scrollTop = scroller.scrollTop
    const viewportHeight = scroller.clientHeight
    const startRow = Math.max(0, Math.floor(scrollTop / tile) - OVERSCAN_ROWS)
    const endRow = Math.min(
      Math.ceil(filtered.length / columns),
      Math.ceil((scrollTop + viewportHeight) / tile) + OVERSCAN_ROWS,
    )
    const startIndex = startRow * columns
    const endIndex = Math.min(filtered.length, endRow * columns)

    const fragment = document.createDocumentFragment()
    for (let i = startIndex; i < endIndex; i++) {
      const symbol = filtered[i]
      const row = Math.floor(i / columns)
      const col = i % columns
      const top = row * tile + TILE_GAP
      const left = col * tile + TILE_GAP
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'symbol-tile'
      button.style.transform = `translate(${left}px, ${top}px)`
      button.style.width = `${TILE_SIZE}px`
      button.style.height = `${TILE_SIZE}px`
      button.setAttribute('data-symbol-name', symbol.name)
      button.setAttribute('data-symbol-scope', symbol.scope)
      button.setAttribute('aria-label', symbol.name)
      const url = `/api/symbols/${encodeURIComponent(symbol.scope)}/${encodeURIComponent(symbol.name)}.svg`
      const icon = document.createElement('span')
      icon.className = 'symbol-tile__icon'
      icon.style.maskImage = `url(${url})`
      icon.style.webkitMaskImage = `url(${url})`
      const label = document.createElement('span')
      label.className = 'symbol-tile__label'
      label.textContent = symbol.name
      button.append(icon, label)
      button.addEventListener('click', () => openDetail(symbol, button))
      fragment.appendChild(button)
    }
    viewport.replaceChildren(fragment)
  }

  function openDetail(symbol, tileButton) {
    lastClickedTile = tileButton
    activeSymbol = symbol
    detail.root.hidden = false
    detail.name.textContent = symbol.name
    detail.scope.textContent = symbol.scope === 'private' ? 'Private CoreGlyphs' : 'Public SF Symbol'
    renderMetadata(symbol)
    refreshDetailPreview()
    detail.closeBtn.focus()
  }

  function closeDetail() {
    detail.root.hidden = true
    activeSymbol = null
    if (lastClickedTile) lastClickedTile.focus()
  }

  function refreshDetailPreview() {
    if (!activeSymbol) return
    const size = Number.parseInt(detail.size.value, 10) || 128
    const fg = normaliseHex(detail.fgHex.value || detail.fg.value) || '#000000'
    const bg = detail.bgTransparent.checked
      ? ''
      : (normaliseHex(detail.bgHex.value || detail.bg.value) || '')
    const params = new URLSearchParams()
    params.set('size', String(size))
    params.set('fg', fg)
    if (bg) params.set('bg', bg)
    const base = `/api/symbols/${encodeURIComponent(activeSymbol.scope)}/${encodeURIComponent(activeSymbol.name)}`
    const svgUrl = `${base}.svg?${params.toString()}`
    const pngUrl = `${base}.png?${params.toString()}`
    detail.preview.src = svgUrl
    detail.preview.alt = activeSymbol.name
    detail.preview.width = size
    detail.preview.height = size
    detail.downloadSvg.href = svgUrl
    detail.downloadSvg.download = `${activeSymbol.name}.svg`
    detail.downloadPng.href = pngUrl
    detail.downloadPng.download = `${activeSymbol.name}.png`
  }

  function renderMetadata(symbol) {
    const rows = []
    rows.push(['Scope', symbol.scope])
    if (symbol.categories.length) rows.push(['Categories', symbol.categories.join(', ')])
    if (symbol.keywords.length) rows.push(['Keywords', symbol.keywords.join(', ')])
    detail.meta.replaceChildren()
    for (const [key, value] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = key
      const dd = document.createElement('dd')
      dd.textContent = value
      detail.meta.append(dt, dd)
    }
  }

  function bindColorPair(picker, hex, onChange) {
    picker.addEventListener('input', () => {
      hex.value = picker.value
      onChange()
    })
    hex.addEventListener('input', () => {
      const normalised = normaliseHex(hex.value)
      if (normalised) picker.value = normalised
      onChange()
    })
  }

  function normaliseHex(value) {
    const raw = String(value || '').trim()
    if (!raw) return ''
    const match = raw.match(/^#?([0-9a-fA-F]{6})$/)
    if (!match) return null
    return `#${match[1].toLowerCase()}`
  }

  function status(text) {
    if (statusEl) statusEl.textContent = text
  }
})()
