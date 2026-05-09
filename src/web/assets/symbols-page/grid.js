// Chunked progressive grid renderer for the SF Symbols page.
//
// Mounting all ~10k tiles up-front makes the DOM and the initial layout
// pass huge even with content-visibility. We mount CHUNK_SIZE tiles, then
// mount the next chunk lazily when an end-sentinel scrolls into view.
// The grid stays scrollable; DOM only grows as the user actually scrolls
// past the current window.

const DEFAULT_CHUNK_SIZE = 480

/**
 * @param {HTMLElement} grid       The grid container that holds the tiles.
 * @param {HTMLElement} scroller   The scrollable parent (root for IntersectionObserver).
 * @param {(symbol: object, tile: HTMLElement) => void} onTileClick
 * @param {{ chunkSize?: number }} [opts]
 */
export function createGridRenderer({ grid, scroller, onTileClick, chunkSize = DEFAULT_CHUNK_SIZE }) {
  let filtered = []
  let renderedCount = 0
  let endSentinel = null
  let chunkObserver = null

  function buildTile(symbol) {
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
    return tile
  }

  function renderNextChunk() {
    if (renderedCount >= filtered.length) {
      if (chunkObserver) {
        chunkObserver.disconnect()
        chunkObserver = null
      }
      if (endSentinel) endSentinel.remove()
      return
    }
    const end = Math.min(renderedCount + chunkSize, filtered.length)
    const frag = document.createDocumentFragment()
    for (let i = renderedCount; i < end; i++) {
      frag.appendChild(buildTile(filtered[i]))
    }
    grid.insertBefore(frag, endSentinel)
    renderedCount = end
    // IntersectionObserver only fires on intersection state CHANGES. If
    // after this insert the sentinel is still inside the rootMargin
    // (e.g. user scrolled fast, or the chunk was small enough that the
    // sentinel didn't get pushed far below the viewport), the observer
    // won't fire again and chunk-loading would stall. Re-check on the
    // next frame and recurse if the sentinel is still within reach.
    requestAnimationFrame(() => {
      if (!endSentinel || renderedCount >= filtered.length) return
      const r = endSentinel.getBoundingClientRect()
      const sr = scroller.getBoundingClientRect()
      if (r.top <= sr.bottom + 600) renderNextChunk()
    })
  }

  function render(nextFiltered) {
    filtered = nextFiltered
    if (chunkObserver) {
      chunkObserver.disconnect()
      chunkObserver = null
    }
    grid.replaceChildren()
    renderedCount = 0
    endSentinel = document.createElement('div')
    endSentinel.className = 'symbols-grid__sentinel'
    endSentinel.setAttribute('aria-hidden', 'true')
    grid.appendChild(endSentinel)

    chunkObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          renderNextChunk()
          break
        }
      }
    }, { root: scroller, rootMargin: '600px 0px 600px 0px' })
    chunkObserver.observe(endSentinel)

    renderNextChunk()
    scroller.scrollTop = 0
  }

  return { render }
}
