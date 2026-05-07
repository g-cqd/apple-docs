// Symbols page (P7) — Phosphor-style global toolbar + Lucide-style
// label-less tile grid. The grid uses CSS Grid `auto-fill`/`minmax()` so
// the column count comes out of CSS, not JS. JS only:
//   - filters (search · scope · category) with ~80ms debounce, AND-composed
//   - URL state `?q=&scope=&cat=` so back-button restores
//   - 600-tile cap until query length >= 2 (cheaper than virtualisation —
//     research/fonts-symbols-ux.md §6.4, Iconify pattern)
//   - the global customizer wires Weight / Scale / Color / Size onto CSS
//     custom props (`--symbol-color`, `--symbol-size`, `--symbol-weight`,
//     `--symbol-scale`) so changing color recolors every visible tile
//     without a re-render (Phosphor pattern)
//   - desktop (≥1024) inspector vs mobile route `/symbols/<name>` is
//     decided via matchMedia and intercepts back/forward navigation
//
// The mask-image contract from src/resources/symbol-pdf-to-svg.js is
// preserved — tiles set `mask-image` on a span whose `background-color`
// is `var(--symbol-color)`. The clip-path-based SVGs (xmark.bin.circle.fill
// etc.) keep working unchanged — they're still consumed as masks.

(function () {
  const GRID = document.getElementById('symbols-grid')
  const SCROLLER = document.getElementById('symbols-scroller')
  const QUERY = document.getElementById('symbols-q')
  const SCOPE = document.getElementById('symbols-scope')
  const CATEGORY_RAIL = document.getElementById('symbols-categories-list')
  const CATEGORY_MOBILE = document.getElementById('symbols-category-mobile')
  const STATUS = document.getElementById('symbols-status')
  const COUNT = document.getElementById('symbols-count')
  const TYPING_HINT = document.getElementById('symbols-typing-hint')
  const COLOR = document.getElementById('symbols-color')
  const COLOR_HEX = document.getElementById('symbols-color-hex')
  const SIZE = document.getElementById('symbols-size')
  const SIZE_VAL = document.getElementById('symbols-size-value')
  const LAYOUT = document.getElementById('symbols-layout')

  if (!GRID || !SCROLLER) return

  const DESKTOP_MQ = window.matchMedia('(min-width: 1024px)')

  let allSymbols = []
  let filtered = []
  let categories = new Map() // name -> count
  let currentCat = ''
  let activeSymbol = null
  let lastClickedTile = null

  // Detail (inspector) DOM refs
  const detail = {
    root: document.getElementById('symbols-detail'),
    closeBtn: document.getElementById('symbols-detail-close'),
    preview: document.getElementById('symbols-detail-preview'),
    name: document.getElementById('symbols-detail-name'),
    scope: document.getElementById('symbols-detail-scope'),
    copyBtn: document.getElementById('symbols-detail-copy-svg'),
    downloadSvg: document.getElementById('symbols-detail-download-svg'),
    downloadPng: document.getElementById('symbols-detail-download-png'),
    meta: document.getElementById('symbols-detail-meta'),
  }
  const mobileBar = {
    root: document.getElementById('symbols-mobile-bar'),
    back: document.getElementById('symbols-mobile-back'),
    name: document.getElementById('symbols-mobile-name'),
    copy: document.getElementById('symbols-mobile-copy'),
  }

  // ---------------------------------------------------------------------
  // 1. Boot — read URL state, then fetch the catalog.
  // ---------------------------------------------------------------------
  const initial = readUrlState()
  if (QUERY) QUERY.value = initial.q
  if (SCOPE) SCOPE.value = initial.scope
  currentCat = initial.cat

  status('Loading symbols…')
  fetch('/api/symbols/index.json', { credentials: 'same-origin' })
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    })
    .then(data => {
      allSymbols = Array.isArray(data.symbols) ? data.symbols : []
      if (COUNT) COUNT.textContent = allSymbols.length.toLocaleString('en-US')
      buildCategoryFacet()
      applyFilters()
      // Mobile detail-route restore: if URL is `/symbols/<name>` we need to
      // load that symbol into the inspector / mobile route.
      const routeName = parseDetailRoute(window.location.pathname)
      if (routeName) {
        const sym = allSymbols.find(s => s.name === routeName)
        if (sym) openDetail(sym, null, { skipPush: true })
      }
    })
    .catch(error => {
      status('Unable to load symbols: ' + error.message)
    })

  // ---------------------------------------------------------------------
  // 2. Filter + render.
  // ---------------------------------------------------------------------
  let filterTimer = 0
  if (QUERY) {
    QUERY.addEventListener('input', () => {
      clearTimeout(filterTimer)
      filterTimer = setTimeout(() => {
        applyFilters()
        writeUrlState()
      }, 80)
    })
  }
  if (SCOPE) {
    SCOPE.addEventListener('change', () => { applyFilters(); writeUrlState() })
  }
  if (CATEGORY_MOBILE) {
    CATEGORY_MOBILE.addEventListener('change', () => {
      currentCat = CATEGORY_MOBILE.value
      reflectCategory()
      applyFilters()
      writeUrlState()
    })
  }

  // Cmd-K / Ctrl-K focuses the search.
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      QUERY?.focus()
      QUERY?.select()
    }
  })

  function applyFilters() {
    const q = (QUERY?.value ?? '').trim().toLowerCase()
    const scope = SCOPE?.value ?? ''
    const cat = currentCat
    const showAll = !q && !scope && !cat
    const next = showAll
      ? allSymbols
      : allSymbols.filter(s => {
        if (scope && s.scope !== scope) return false
        if (cat && !(s.categories || []).some(c => c.toLowerCase() === cat.toLowerCase())) return false
        if (!q) return true
        if (s.name.toLowerCase().includes(q)) return true
        if ((s.categories || []).some(v => v.toLowerCase().includes(q))) return true
        if ((s.keywords || []).some(v => v.toLowerCase().includes(q))) return true
        return false
      })

    // Render every match. With ~10k symbols and `content-visibility: auto`
    // + `contain-intrinsic-size` on the grid, offscreen rows are skipped
    // by the browser's layout/paint pipeline — first render stays under
    // ~150ms on a Retina iPhone profile and scrolling stays smooth.
    // Mask-image fetches are kicked off lazily as rows scroll into view.
    const total = next.length
    filtered = next
    TYPING_HINT.hidden = true
    TYPING_HINT.textContent = ''

    status(`${total.toLocaleString('en-US')} matching symbol${total === 1 ? '' : 's'}`)
    render()
  }

  function render() {
    const frag = document.createDocumentFragment()
    for (const symbol of filtered) {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = 'symbol-tile'
      tile.dataset.symbolName = symbol.name
      tile.dataset.symbolScope = symbol.scope
      tile.setAttribute('role', 'gridcell')
      tile.setAttribute('aria-label', symbol.name)
      const url = `/api/symbols/${encodeURIComponent(symbol.scope)}/${encodeURIComponent(symbol.name)}.svg`
      const icon = document.createElement('span')
      icon.className = 'symbol-tile__icon'
      icon.style.maskImage = `url(${url})`
      icon.style.webkitMaskImage = `url(${url})`
      const tip = document.createElement('span')
      tip.className = 'symbol-tile__tooltip'
      tip.textContent = symbol.name
      tile.append(icon, tip)
      tile.addEventListener('click', () => onTileClick(symbol, tile))
      frag.appendChild(tile)
    }
    GRID.replaceChildren(frag)
    SCROLLER.scrollTop = 0
  }

  // ---------------------------------------------------------------------
  // 3. Category facet.
  // ---------------------------------------------------------------------
  function buildCategoryFacet() {
    categories = new Map()
    for (const s of allSymbols) {
      for (const c of s.categories || []) {
        categories.set(c, (categories.get(c) ?? 0) + 1)
      }
    }
    const entries = [...categories.entries()].sort((a, b) => a[0].localeCompare(b[0]))

    // Desktop rail
    if (CATEGORY_RAIL) {
      CATEGORY_RAIL.replaceChildren()
      CATEGORY_RAIL.appendChild(catRailItem('', 'All', allSymbols.length))
      for (const [name, count] of entries) {
        CATEGORY_RAIL.appendChild(catRailItem(name, name, count))
      }
    }

    // Mobile select
    if (CATEGORY_MOBILE) {
      CATEGORY_MOBILE.replaceChildren()
      const all = document.createElement('option')
      all.value = ''
      all.textContent = `All categories (${allSymbols.length.toLocaleString('en-US')})`
      CATEGORY_MOBILE.appendChild(all)
      for (const [name, count] of entries) {
        const opt = document.createElement('option')
        opt.value = name
        opt.textContent = `${name} (${count})`
        CATEGORY_MOBILE.appendChild(opt)
      }
      CATEGORY_MOBILE.value = currentCat
    }
    reflectCategory()
  }

  function catRailItem(value, label, count) {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'symbols-category'
    btn.dataset.cat = value
    btn.setAttribute('aria-pressed', value === currentCat ? 'true' : 'false')
    btn.innerHTML = `<span class="symbols-category__label"></span><span class="symbols-category__count"></span>`
    btn.querySelector('.symbols-category__label').textContent = label
    btn.querySelector('.symbols-category__count').textContent = count.toLocaleString('en-US')
    btn.addEventListener('click', () => {
      currentCat = currentCat === value ? '' : value
      reflectCategory()
      applyFilters()
      writeUrlState()
    })
    li.appendChild(btn)
    return li
  }

  function reflectCategory() {
    if (CATEGORY_RAIL) {
      for (const btn of CATEGORY_RAIL.querySelectorAll('.symbols-category')) {
        btn.setAttribute('aria-pressed', btn.dataset.cat === currentCat ? 'true' : 'false')
      }
    }
    if (CATEGORY_MOBILE && CATEGORY_MOBILE.value !== currentCat) {
      CATEGORY_MOBILE.value = currentCat
    }
  }

  // ---------------------------------------------------------------------
  // 4. Customizer — color + tile size are page-wide (CSS custom props on
  //    the page). Weight + scale are inspector-only because the grid
  //    serves prerendered SVGs at the default configuration; rerunning
  //    the Swift renderer for every visible tile on every weight change
  //    is prohibitively expensive (~thousand requests). The inspector's
  //    `<img>` re-fetches with the new params, which is cheap.
  // ---------------------------------------------------------------------
  const root = document.querySelector('.symbols-page')
  const detailWeight = { value: 'regular' }
  const detailScale = { value: 'medium' }

  document.querySelectorAll('.symbols-control--weight .symbols-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      pickPill(pill, '.symbols-control--weight .symbols-pill')
      detailWeight.value = pill.dataset.weight
      refreshDetail()
    })
  })
  document.querySelectorAll('.symbols-control--scale .symbols-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      pickPill(pill, '.symbols-control--scale .symbols-pill')
      detailScale.value = pill.dataset.scale
      refreshDetail()
    })
  })

  function pickPill(activePill, selector) {
    document.querySelectorAll(selector).forEach(p => {
      p.setAttribute('aria-checked', p === activePill ? 'true' : 'false')
    })
  }

  // Color picker (paired hex/colour input).
  //
  // Default behaviour: leave `--symbol-color` unset so the CSS fallback
  // `var(--symbol-color, currentColor)` resolves to the page's text
  // colour — automatically dark on light theme, light on dark theme.
  // Only override once the user actually touches the picker. We can't
  // tell apart "user picked black" from "browser default black" via the
  // input value alone, so we set a `data-touched` flag on the first
  // input event and key off that.
  if (COLOR && COLOR_HEX) {
    let touched = false
    const apply = () => {
      if (!touched) return
      const v = normaliseHex(COLOR_HEX.value || COLOR.value)
      if (v) root.style.setProperty('--symbol-color', v)
    }
    const markTouched = () => {
      if (touched) return
      touched = true
      apply()
    }
    COLOR.addEventListener('input', markTouched)
    COLOR_HEX.addEventListener('input', markTouched)
    bindColorPair(COLOR, COLOR_HEX, apply)
  }

  // Size slider.
  if (SIZE && SIZE_VAL) {
    SIZE.addEventListener('input', () => {
      const px = Number.parseInt(SIZE.value, 10) || 48
      SIZE_VAL.textContent = String(px)
      root.style.setProperty('--symbol-size', `${px}px`)
    })
    root.style.setProperty('--symbol-size', `${SIZE.value}px`)
  }

  // ---------------------------------------------------------------------
  // 5. Tile click → inspector (desktop) or route (mobile).
  // ---------------------------------------------------------------------
  function onTileClick(symbol, tile) {
    if (DESKTOP_MQ.matches) {
      openDetail(symbol, tile)
    } else {
      // Mobile: navigate to `/symbols/<name>` so back-button restores
      // the grid + scroll position.
      const url = `/symbols/${encodeURIComponent(symbol.name)}${window.location.search}`
      history.pushState({ symbolName: symbol.name }, '', url)
      openDetail(symbol, tile, { skipPush: true })
    }
  }

  function openDetail(symbol, tile, opts = {}) {
    activeSymbol = symbol
    lastClickedTile = tile
    if (detail.root) detail.root.hidden = false
    if (detail.name) detail.name.textContent = symbol.name
    if (detail.scope) detail.scope.textContent =
      symbol.scope === 'private' ? 'Private CoreGlyphs' : 'Public SF Symbol'
    // Surface the "weight/scale apply to public only" hint when looking
    // at a private symbol — withSymbolConfiguration is a no-op there.
    const axesHint = document.getElementById('symbols-detail-axes-hint')
    if (axesHint) axesHint.hidden = symbol.scope !== 'private'
    refreshDetail()
    fetchMetadata(symbol).then(meta => {
      if (activeSymbol === symbol) renderMetadata(meta)
    })
    if (mobileBar.root) {
      mobileBar.root.hidden = DESKTOP_MQ.matches
      if (mobileBar.name) mobileBar.name.textContent = symbol.name
    }
    if (LAYOUT) LAYOUT.classList.add('symbols-layout--detail-open')
    void opts
  }

  // Catalog payload only carries name + scope + categories + keywords —
  // aliases and availability live in the per-symbol JSON endpoint and
  // are fetched lazily on inspector open. Cached in-memory so revisiting
  // a symbol doesn't re-hit the API.
  const metadataCache = new Map()
  async function fetchMetadata(symbol) {
    const key = `${symbol.scope}/${symbol.name}`
    if (metadataCache.has(key)) return metadataCache.get(key)
    try {
      const res = await fetch(`/api/symbols/${encodeURIComponent(symbol.scope)}/${encodeURIComponent(symbol.name)}.json`)
      if (!res.ok) return symbol
      const full = await res.json()
      const merged = { ...symbol, ...full }
      metadataCache.set(key, merged)
      return merged
    } catch {
      return symbol
    }
  }

  function closeDetail() {
    activeSymbol = null
    if (detail.root) detail.root.hidden = true
    if (mobileBar.root) mobileBar.root.hidden = true
    if (LAYOUT) LAYOUT.classList.remove('symbols-layout--detail-open')
    if (lastClickedTile) lastClickedTile.focus()
    // If we're at /symbols/<name>, pop back to /symbols.
    const routeName = parseDetailRoute(window.location.pathname)
    if (routeName) {
      history.pushState({}, '', `/symbols${window.location.search}`)
    }
  }

  detail.closeBtn?.addEventListener('click', closeDetail)
  mobileBar.back?.addEventListener('click', () => history.back())
  SCROLLER.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeDetail()
  })

  function refreshDetail() {
    if (!activeSymbol) return
    const base = `/api/symbols/${encodeURIComponent(activeSymbol.scope)}/${encodeURIComponent(activeSymbol.name)}`
    // The inspector preview is an `<img>` element: <img src> is rendered
    // by the browser image decoder and does NOT inherit `currentColor`
    // from its parent the way an inline SVG would. Resolve the active
    // text colour to a hex so the rendered preview honours the theme,
    // and only override when the user has explicitly picked a colour.
    const userColor = readVar('--symbol-color')
    const fg = userColor || resolvedThemeFg()
    const params = new URLSearchParams()
    params.set('size', '256')
    params.set('fg', fg)
    if (detailWeight.value !== 'regular') params.set('weight', detailWeight.value)
    if (detailScale.value !== 'medium') params.set('scale', detailScale.value)
    const svgUrl = `${base}.svg?${params.toString()}`
    const pngUrl = `${base}.png?${params.toString()}`
    if (detail.preview) {
      detail.preview.src = svgUrl
      detail.preview.alt = activeSymbol.name
    }
    if (detail.downloadSvg) {
      detail.downloadSvg.href = svgUrl
      detail.downloadSvg.download = `${activeSymbol.name}.svg`
    }
    if (detail.downloadPng) {
      detail.downloadPng.href = pngUrl
      detail.downloadPng.download = `${activeSymbol.name}.png`
    }
  }

  // Render only the metadata fields that have content. The catalog has a
  // long tail of symbols with empty keywords / no aliases / no availability
  // overrides — surfacing every field as a dt/dd pair makes near-empty
  // metadata blocks look identical across symbols. Skip empties and
  // expose the structural pieces of the symbol name (variant + base)
  // as a "Composition" row so each symbol shows something distinctive.
  function renderMetadata(symbol) {
    if (!detail.meta) return
    detail.meta.replaceChildren()
    const rows = []
    rows.push(['Scope', symbol.scope === 'private' ? 'Private CoreGlyphs' : 'Public SF Symbols'])
    const composition = describeComposition(symbol.name)
    if (composition) rows.push(['Composition', composition])
    if ((symbol.categories || []).length) rows.push(['Categories', symbol.categories.join(', ')])
    if ((symbol.keywords || []).length) rows.push(['Keywords', symbol.keywords.join(', ')])
    const aliases = formatAliases(symbol.aliases)
    if (aliases) rows.push(['Aliases', aliases])
    const availability = formatAvailability(symbol.availability)
    if (availability) rows.push(['Availability', availability])
    if (symbol.bundle_version || symbol.bundleVersion) {
      rows.push(['Bundle', symbol.bundle_version ?? symbol.bundleVersion])
    }
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k
      const dd = document.createElement('dd'); dd.textContent = v
      detail.meta.append(dt, dd)
    }
  }

  // Copy SVG button (inspector + mobile bar).
  async function copySvg() {
    if (!activeSymbol) return
    try {
      const fg = readVar('--symbol-color')
      const base = `/api/symbols/${encodeURIComponent(activeSymbol.scope)}/${encodeURIComponent(activeSymbol.name)}.svg`
      // No user-set colour → copy the theme-neutral prerendered SVG
      // (currentColor-friendly). Once the user has picked a colour,
      // bake it into the copied bytes via the live render path.
      const url = fg ? `${base}?fg=${encodeURIComponent(fg)}` : base
      const res = await fetch(url)
      const text = await res.text()
      await navigator.clipboard.writeText(text)
      status('SVG copied to clipboard')
    } catch (err) {
      status('Copy failed: ' + err.message)
    }
  }
  detail.copyBtn?.addEventListener('click', copySvg)
  mobileBar.copy?.addEventListener('click', copySvg)

  // ---------------------------------------------------------------------
  // 6. URL state — `?q=&scope=&cat=` plus `/symbols/<name>` route.
  // ---------------------------------------------------------------------
  function readUrlState() {
    const params = new URLSearchParams(window.location.search)
    return {
      q: params.get('q') || '',
      scope: params.get('scope') || '',
      cat: params.get('cat') || '',
    }
  }

  function writeUrlState() {
    const params = new URLSearchParams()
    if (QUERY?.value) params.set('q', QUERY.value)
    if (SCOPE?.value) params.set('scope', SCOPE.value)
    if (currentCat) params.set('cat', currentCat)
    const qs = params.toString()
    const detailName = parseDetailRoute(window.location.pathname)
    const path = detailName ? `/symbols/${encodeURIComponent(detailName)}` : '/symbols'
    const next = qs ? `${path}?${qs}` : path
    if (next !== `${window.location.pathname}${window.location.search}`) {
      history.replaceState(history.state, '', next)
    }
  }

  function parseDetailRoute(pathname) {
    const m = pathname.match(/^\/symbols\/(.+?)\/?$/)
    return m ? decodeURIComponent(m[1]) : null
  }

  window.addEventListener('popstate', () => {
    const state = readUrlState()
    if (QUERY) QUERY.value = state.q
    if (SCOPE) SCOPE.value = state.scope
    currentCat = state.cat
    reflectCategory()
    applyFilters()
    const routeName = parseDetailRoute(window.location.pathname)
    if (routeName) {
      const sym = allSymbols.find(s => s.name === routeName)
      if (sym) openDetail(sym, null, { skipPush: true })
    } else {
      closeDetailNoNav()
    }
  })

  function closeDetailNoNav() {
    activeSymbol = null
    if (detail.root) detail.root.hidden = true
    if (mobileBar.root) mobileBar.root.hidden = true
    if (LAYOUT) LAYOUT.classList.remove('symbols-layout--detail-open')
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------
  function status(text) {
    if (STATUS) STATUS.textContent = text
  }

  function readVar(name) {
    return getComputedStyle(root).getPropertyValue(name).trim()
  }

  function bindColorPair(picker, hex, onChange) {
    picker.addEventListener('input', () => {
      hex.value = picker.value
      onChange()
    })
    hex.addEventListener('input', () => {
      const norm = normaliseHex(hex.value)
      if (norm) picker.value = norm
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

  // Many symbols share the same categories/keywords payload (e.g. every
  // ".badge" variant of "person" carries the same {human} category). To
  // give the metadata block something distinctive per symbol, decompose
  // the dotted name into base + modifiers ("circle.fill" → base "circle"
  // with modifier "fill"; "person.2.badge.app.3.stack.3d.fill" → "person",
  // "2", "badge", "app", "3", "stack", "3d", "fill"). The display string
  // emphasises the stem and lists the modifiers in stack order.
  function describeComposition(name) {
    if (!name) return ''
    const parts = name.split('.').filter(Boolean)
    if (parts.length === 1) return ''
    const stem = parts[0]
    const modifiers = parts.slice(1)
    return `${stem} → ${modifiers.join(' → ')}`
  }

  function formatAliases(aliases) {
    if (!aliases) return ''
    if (Array.isArray(aliases)) return aliases.length ? aliases.join(', ') : ''
    if (typeof aliases === 'object') {
      const keys = Object.keys(aliases)
      return keys.length ? keys.join(', ') : ''
    }
    return ''
  }

  // Availability is shipped as `{ "iOS": "18.0", "macOS": "15.0", … }`.
  // Render in OS order, omit unset platforms.
  function formatAvailability(availability) {
    if (!availability || typeof availability !== 'object') return ''
    const platformOrder = ['iOS', 'iPadOS', 'macOS', 'watchOS', 'tvOS', 'visionOS']
    const seen = new Set(platformOrder)
    const ordered = [...platformOrder.filter(p => availability[p]), ...Object.keys(availability).filter(p => !seen.has(p))]
    const parts = ordered
      .map(p => availability[p] ? `${p} ${availability[p]}` : null)
      .filter(Boolean)
    return parts.join(', ')
  }

  // Snap the page's computed text colour to a hex string suitable for
  // the symbol-render API. The browser returns `rgb(r, g, b)` /
  // `rgba(...)` from getComputedStyle even when CSS used a named
  // colour, so a small parser handles both. Falls back to `#000000` if
  // the format is unexpected (e.g. `oklch()` on very new browsers).
  function resolvedThemeFg() {
    const raw = getComputedStyle(document.body).color || ''
    const m = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
    if (!m) return '#000000'
    const hex = (n) => Number(n).toString(16).padStart(2, '0')
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
  }

})()
