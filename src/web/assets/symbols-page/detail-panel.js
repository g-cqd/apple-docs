// Symbols-page detail panel: inspector on desktop, full-page route on
// mobile. Decouples the metadata fetch + render + copy/download wiring
// from the controller so the boot path stays focused on filters + grid.

import {
  describeComposition,
  formatAliases,
  formatAvailability,
  readVar,
  resolvedThemeFg,
} from './format.js'

/**
 * Cache of full per-symbol JSON (aliases, availability — fields not in
 * the catalog payload). Keyed by `${scope}/${name}`. Module-local but
 * fine because each page reloads the controller from scratch.
 */
const metadataCache = new Map()

async function fetchMetadata(symbol) {
  const key = `${symbol.scope}/${symbol.name}`
  if (metadataCache.has(key)) return metadataCache.get(key)
  try {
    const res = await fetch(
      `/api/symbols/${encodeURIComponent(symbol.scope)}/${encodeURIComponent(symbol.name)}.json`,
    )
    if (!res.ok) return symbol
    const full = await res.json()
    const merged = { ...symbol, ...full }
    metadataCache.set(key, merged)
    return merged
  } catch {
    return symbol
  }
}

/**
 * Render only the metadata fields that have content. The catalog has a
 * long tail of symbols with empty keywords / no aliases / no availability
 * overrides — surfacing every field as a dt/dd pair makes near-empty
 * metadata blocks look identical across symbols. Skip empties and expose
 * the structural pieces of the symbol name as a "Composition" row so each
 * symbol shows something distinctive.
 */
function renderMetadata(detailMeta, symbol) {
  if (!detailMeta) return
  detailMeta.replaceChildren()
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
  if (symbol.codepoint_display) rows.push(['Unicode', symbol.codepoint_display])
  if (symbol.bundle_version || symbol.bundleVersion) {
    rows.push(['Bundle', symbol.bundle_version ?? symbol.bundleVersion])
  }
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k
    const dd = document.createElement('dd'); dd.textContent = v
    detailMeta.append(dt, dd)
  }
}

/**
 * Build the detail-panel controller. Returns object with open / close /
 * refresh / copy methods so the page-level controller can drive the
 * inspector from outside (tile clicks, popstate, keyboard, etc).
 *
 * @param {object} deps DOM refs + a `setStatus(text)` callback + the
 *   page root element (used for `--symbol-color` lookups).
 */
export function createDetailPanel(deps) {
  const { detail, mobileBar, layout, root, setStatus, isDesktop } = deps
  const detailWeight = { value: 'regular' }
  const detailScale = { value: 'medium' }
  let activeSymbol = null
  let lastClickedTile = null

  function refreshDetail() {
    if (!activeSymbol) return
    const base = `/api/symbols/${encodeURIComponent(activeSymbol.scope)}/${encodeURIComponent(activeSymbol.name)}`
    // The preview is a <span> with `mask-image` (same recipe as the grid
    // tile). When weight/scale are at their defaults, point the mask at
    // the unparameterized URL so the bytes already cached by the grid
    // tile are reused — no re-fetch, no Swift live-render. Color comes
    // from `--symbol-color` / `currentColor` automatically.
    const previewParams = new URLSearchParams()
    if (detailWeight.value !== 'regular') previewParams.set('weight', detailWeight.value)
    if (detailScale.value !== 'medium') previewParams.set('scale', detailScale.value)
    const previewQs = previewParams.toString()
    const previewUrl = previewQs ? `${base}.svg?${previewQs}` : `${base}.svg`
    if (detail.preview) {
      detail.preview.style.maskImage = `url(${previewUrl})`
      detail.preview.style.webkitMaskImage = `url(${previewUrl})`
      detail.preview.setAttribute('aria-label', activeSymbol.name)
    }
    // Downloads bake the active color so the saved file is self-contained.
    const userColor = readVar(root, '--symbol-color')
    const fg = userColor || resolvedThemeFg()
    const dlParams = new URLSearchParams(previewParams)
    dlParams.set('size', '256')
    dlParams.set('fg', fg)
    if (detail.downloadSvg) {
      detail.downloadSvg.href = `${base}.svg?${dlParams.toString()}`
      detail.downloadSvg.download = `${activeSymbol.name}.svg`
    }
    if (detail.downloadPng) {
      detail.downloadPng.href = `${base}.png?${dlParams.toString()}`
      detail.downloadPng.download = `${activeSymbol.name}.png`
    }
  }

  function open(symbol, tile) {
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
      if (activeSymbol === symbol) renderMetadata(detail.meta, meta)
    })
    if (mobileBar.root) {
      mobileBar.root.hidden = isDesktop()
      if (mobileBar.name) mobileBar.name.textContent = symbol.name
    }
    if (layout) layout.classList.add('symbols-layout--detail-open')
  }

  // Close + return focus + pop /symbols/<name> route when present.
  function close() {
    activeSymbol = null
    if (detail.root) detail.root.hidden = true
    if (mobileBar.root) mobileBar.root.hidden = true
    if (layout) layout.classList.remove('symbols-layout--detail-open')
    if (lastClickedTile) lastClickedTile.focus()
    // popstate handler also calls closeNoNav; the route pop here is the
    // "user clicked the X button" path.
    return /^\/symbols\//.test(window.location.pathname)
  }

  // Close without touching history (used by popstate).
  function closeNoNav() {
    activeSymbol = null
    if (detail.root) detail.root.hidden = true
    if (mobileBar.root) mobileBar.root.hidden = true
    if (layout) layout.classList.remove('symbols-layout--detail-open')
  }

  async function copySvg() {
    if (!activeSymbol) return
    try {
      const fg = readVar(root, '--symbol-color')
      const base = `/api/symbols/${encodeURIComponent(activeSymbol.scope)}/${encodeURIComponent(activeSymbol.name)}.svg`
      // No user-set colour → copy the theme-neutral prerendered SVG
      // (currentColor-friendly). Once the user has picked a colour,
      // bake it into the copied bytes via the live render path.
      const url = fg ? `${base}?fg=${encodeURIComponent(fg)}` : base
      const res = await fetch(url)
      const text = await res.text()
      await navigator.clipboard.writeText(text)
      setStatus('SVG copied to clipboard')
    } catch (err) {
      setStatus(`Copy failed: ${err.message}`)
    }
  }

  function setWeight(value) { detailWeight.value = value; refreshDetail() }
  function setScale(value) { detailScale.value = value; refreshDetail() }
  function getActiveSymbol() { return activeSymbol }

  return { open, close, closeNoNav, refresh: refreshDetail, copySvg, setWeight, setScale, getActiveSymbol }
}
