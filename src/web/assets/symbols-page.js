// Symbols page — Phosphor-style global toolbar + Lucide-style
// label-less tile grid.
//
// Pure formatters live in symbols-page/format.js, URL state in
// symbols-page/url-state.js, the chunked grid renderer in
// symbols-page/grid.js, and the inspector / mobile-route detail panel
// in symbols-page/detail-panel.js. This module owns the boot flow, the
// filter compose, the customizer wire-up, and history routing.

import { bindColorPair, normaliseHex } from './symbols-page/format.js'
import { parseDetailRoute, readUrlState, writeUrlState } from './symbols-page/url-state.js'
import { createGridRenderer } from './symbols-page/grid.js'
import { createDetailPanel } from './symbols-page/detail-panel.js'

function init() {
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
  const root = document.querySelector('.symbols-page')

  let allSymbols = []
  let categories = new Map()
  let currentCat = ''

  function setStatus(text) { if (STATUS) STATUS.textContent = text }

  // ---- Detail panel ----
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
  const panel = createDetailPanel({
    detail, mobileBar, layout: LAYOUT, root, setStatus,
    isDesktop: () => DESKTOP_MQ.matches,
  })

  // ---- Tile click → inspector (desktop) or route (mobile) ----
  function onTileClick(symbol, tile) {
    if (DESKTOP_MQ.matches) {
      panel.open(symbol, tile)
    } else {
      const url = `/symbols/${encodeURIComponent(symbol.name)}${window.location.search}`
      history.pushState({ symbolName: symbol.name }, '', url)
      panel.open(symbol, tile)
    }
  }
  const grid = createGridRenderer({ grid: GRID, scroller: SCROLLER, onTileClick })

  // ---- Boot ----
  const initial = readUrlState()
  if (QUERY) QUERY.value = initial.q
  if (SCOPE) SCOPE.value = initial.scope
  currentCat = initial.cat

  setStatus('Loading symbols…')
  fetch('/api/symbols/index.json', { credentials: 'same-origin' })
    .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() })
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
        if (sym) panel.open(sym, null)
      }
    })
    .catch(error => setStatus(`Unable to load symbols: ${error.message}`))

  // ---- Filter compose ----
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
    if (TYPING_HINT) { TYPING_HINT.hidden = true; TYPING_HINT.textContent = '' }
    setStatus(`${next.length.toLocaleString('en-US')} matching symbol${next.length === 1 ? '' : 's'}`)
    grid.render(next)
  }

  let filterTimer = 0
  if (QUERY) {
    QUERY.addEventListener('input', () => {
      clearTimeout(filterTimer)
      filterTimer = setTimeout(() => { applyFilters(); writeUrlStateNow() }, 80)
    })
  }
  if (SCOPE) SCOPE.addEventListener('change', () => { applyFilters(); writeUrlStateNow() })
  if (CATEGORY_MOBILE) {
    CATEGORY_MOBILE.addEventListener('change', () => {
      currentCat = CATEGORY_MOBILE.value
      reflectCategory()
      applyFilters()
      writeUrlStateNow()
    })
  }

  function writeUrlStateNow() {
    writeUrlState({ q: QUERY?.value || '', scope: SCOPE?.value || '', cat: currentCat })
  }

  // Cmd-K / Ctrl-K focuses the search.
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault()
      QUERY?.focus()
      QUERY?.select()
    }
  })

  // ---- Category facet ----
  function buildCategoryFacet() {
    categories = new Map()
    for (const s of allSymbols) {
      for (const c of s.categories || []) {
        categories.set(c, (categories.get(c) ?? 0) + 1)
      }
    }
    const entries = [...categories.entries()].sort((a, b) => a[0].localeCompare(b[0]))

    if (CATEGORY_RAIL) {
      CATEGORY_RAIL.replaceChildren()
      CATEGORY_RAIL.appendChild(catRailItem('', 'All', allSymbols.length))
      for (const [name, count] of entries) {
        CATEGORY_RAIL.appendChild(catRailItem(name, name, count))
      }
    }

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
      writeUrlStateNow()
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

  // ---- Customizer (color + size are page-wide CSS custom props) ----
  // Default behaviour: leave `--symbol-color` unset so the CSS fallback
  // resolves to the page's text colour. Only override once the user
  // touches the picker.
  document.querySelectorAll('.symbols-control--weight .symbols-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      pickPill(pill, '.symbols-control--weight .symbols-pill')
      panel.setWeight(pill.dataset.weight)
    })
  })
  document.querySelectorAll('.symbols-control--scale .symbols-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      pickPill(pill, '.symbols-control--scale .symbols-pill')
      panel.setScale(pill.dataset.scale)
    })
  })

  function pickPill(activePill, selector) {
    document.querySelectorAll(selector).forEach(p => {
      p.setAttribute('aria-checked', p === activePill ? 'true' : 'false')
    })
  }

  if (COLOR && COLOR_HEX) {
    let touched = false
    const apply = () => {
      if (!touched) return
      const v = normaliseHex(COLOR_HEX.value || COLOR.value)
      if (v) root.style.setProperty('--symbol-color', v)
    }
    const markTouched = () => { if (touched) return; touched = true; apply() }
    COLOR.addEventListener('input', markTouched)
    COLOR_HEX.addEventListener('input', markTouched)
    bindColorPair(COLOR, COLOR_HEX, apply)
  }

  if (SIZE && SIZE_VAL) {
    SIZE.addEventListener('input', () => {
      const px = Number.parseInt(SIZE.value, 10) || 48
      SIZE_VAL.textContent = String(px)
      root.style.setProperty('--symbol-size', `${px}px`)
    })
    root.style.setProperty('--symbol-size', `${SIZE.value}px`)
  }

  // ---- Detail wire-up ----
  detail.closeBtn?.addEventListener('click', () => {
    if (panel.close()) history.pushState({}, '', `/symbols${window.location.search}`)
  })
  mobileBar.back?.addEventListener('click', () => history.back())
  SCROLLER.addEventListener('keydown', event => {
    if (event.key === 'Escape') panel.close()
  })
  detail.copyBtn?.addEventListener('click', () => panel.copySvg())
  mobileBar.copy?.addEventListener('click', () => panel.copySvg())

  // ---- Popstate ----
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
      if (sym) panel.open(sym, null)
    } else {
      panel.closeNoNav()
    }
  })
}

init()
