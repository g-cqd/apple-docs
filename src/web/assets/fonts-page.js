// Fonts page — Google-Fonts-style global tester.
//
// Sample text · size · weight · italic are SINGLE controls at the top
// of the page; every family preview line follows them. Per-family
// per-variant controls were removed because they multiplied N times
// down the page (one set of weight pills per family × variant) and
// drowned out the actual previews.
//
// Each family card renders ONE preview line that picks the closest
// matching file (variant preference: Default/Text → Display → first
// available; weight: nearest match; italic: matching italic file when
// available, otherwise the upright file with `font-style: italic`).
// Variable fonts apply weight via `font-weight`/`font-variation-settings`
// directly so the slider is continuous within 100–900.
//
// Tag chips render in their own visual style (Adobe pattern): the
// "Sans-serif" chip is set in a sans face, "Serif" in serif, etc.

function init() {
  const VARIANT_ORDER = ['Display', 'Text', 'Rounded', 'ExtraLarge', 'Large', 'Medium', 'Small', '__default__']
  const WEIGHT_NUMERIC = {
    Ultralight: 100, Thin: 200, Light: 300, Regular: 400, Medium: 500,
    Semibold: 600, Bold: 700, Heavy: 800, Black: 900,
  }

  const dataNode = document.getElementById('fonts-data')
  if (!dataNode) return
  let families
  try {
    families = JSON.parse(dataNode.textContent)
  } catch {
    families = []
  }
  if (!families.length) return

  const sampleEl = document.getElementById('fonts-sample')
  const sizeEl = document.getElementById('fonts-size')
  const sizeValueEl = document.getElementById('fonts-size-value')
  const weightEl = document.getElementById('fonts-weight')
  const weightValueEl = document.getElementById('fonts-weight-value')
  const italicEl = document.getElementById('fonts-italic')
  const styleEl = document.getElementById('fonts-style')
  const chipsEl = document.getElementById('fonts-chips')
  const railListEl = document.getElementById('fonts-rail-list')
  const grid = document.getElementById('font-family-grid')
  const bottomCta = document.getElementById('fonts-bottom-bar-cta')
  const bottomAll = document.getElementById('fonts-bottom-bar-all')
  const root = document.querySelector('.fonts-page') || document.body

  // Single global state. Family previews react via `applyGlobals()`.
  const globals = {
    weight: weightEl ? Number.parseInt(weightEl.value, 10) || 400 : 400,
    italic: !!italicEl?.checked,
    style: styleEl?.value || 'auto',
  }

  // ---------------------------------------------------------------------
  // 1. Inject @font-face for every family file.
  // ---------------------------------------------------------------------
  const styleSheet = document.createElement('style')
  styleSheet.id = 'fonts-page-faces'
  document.head.appendChild(styleSheet)

  const cssNameByFileId = new Map()
  const cssRules = []
  for (const family of families) {
    for (const file of family.files) {
      const cssName = `apple-docs-${family.id}-${file.id}`
      cssNameByFileId.set(file.id, cssName)
      const url = `/api/fonts/file/${encodeURIComponent(file.id)}`
      const format = formatHint(file.format)
      cssRules.push(`@font-face { font-family: "${cssName}"; src: url("${url}")${format ? ` format("${format}")` : ''}; font-display: swap; }`)
    }
  }
  styleSheet.textContent = cssRules.join('\n')

  // ---------------------------------------------------------------------
  // 2. Per-family card render: one preview line, no controls.
  //    The variant container (`[data-variants]`) stays in the DOM but
  //    empty — kept for layout slot symmetry, removed from a11y tree.
  // ---------------------------------------------------------------------
  const cardStates = []
  document.querySelectorAll('.font-family').forEach(card => {
    const familyId = card.getAttribute('data-family-id')
    const family = families.find(f => f.id === familyId)
    if (!family) return
    const variantsEl = card.querySelector('[data-variants]')
    const previewEl = card.querySelector('[data-preview]')
    if (variantsEl) {
      variantsEl.replaceChildren()
      variantsEl.hidden = true
    }
    const groups = groupByVariant(family.files)

    const previewLine = document.createElement('div')
    previewLine.className = 'font-preview-line'
    previewLine.contentEditable = 'true'
    previewLine.spellcheck = false
    previewLine.setAttribute('aria-label', `${family.display_name} sample — click to edit`)
    previewLine.dataset.familyId = family.id
    previewLine.addEventListener('input', () => {
      previewLine.dataset.overridden = 'true'
    })
    previewEl?.appendChild(previewLine)

    cardStates.push({ family, groups, previewLine })
  })

  // ---------------------------------------------------------------------
  // 3. Apply the global controls to every visible preview.
  // ---------------------------------------------------------------------
  function applyGlobals() {
    for (const { family, groups, previewLine } of cardStates) {
      const file = pickFileForGlobals(family, groups, globals)
      if (!file) {
        previewLine.style.fontFamily = 'system-ui, sans-serif'
        previewLine.style.fontWeight = globals.weight
        previewLine.style.fontStyle = globals.italic ? 'italic' : 'normal'
        previewLine.style.fontVariationSettings = ''
        previewLine.dataset.fileId = ''
        continue
      }
      previewLine.style.fontFamily = `"${cssNameByFileId.get(file.id)}", system-ui, sans-serif`
      previewLine.style.fontWeight = globals.weight
      // Italic: prefer an actual italic file; fall back to synthesized
      // oblique via `font-style` if the family doesn't ship one.
      previewLine.style.fontStyle = globals.italic ? 'italic' : 'normal'
      // Variable wght axis takes the global numeric weight directly.
      if (file.is_variable) {
        previewLine.style.fontVariationSettings = `"wght" ${globals.weight}`
      } else {
        previewLine.style.fontVariationSettings = ''
      }
      previewLine.dataset.fileId = file.id
    }
  }

  // ---------------------------------------------------------------------
  // 4. Global sample text + size (propagate to every preview).
  // ---------------------------------------------------------------------
  function applySample() {
    const text = sampleEl?.value || 'Reading Apple docs in good type.'
    root.style.setProperty('--sample-text', JSON.stringify(text))
    document.querySelectorAll('.font-preview-line').forEach(line => {
      if (line.dataset.overridden === 'true') return
      line.textContent = text
    })
  }

  function applySize() {
    const size = Number.parseInt(sizeEl?.value, 10) || 48
    if (sizeValueEl) sizeValueEl.textContent = String(size)
    root.style.setProperty('--sample-size', `${size}px`)
    document.querySelectorAll('.font-preview-line').forEach(line => {
      line.style.fontSize = `${size}px`
    })
  }

  function applyWeight() {
    globals.weight = Number.parseInt(weightEl?.value, 10) || 400
    if (weightValueEl) weightValueEl.textContent = String(globals.weight)
    applyGlobals()
  }

  function applyItalic() {
    globals.italic = !!italicEl?.checked
    applyGlobals()
  }

  function applyStyle() {
    globals.style = styleEl?.value || 'auto'
    applyGlobals()
  }

  applySample()
  applySize()
  applyGlobals()
  sampleEl?.addEventListener('input', applySample)
  sizeEl?.addEventListener('input', applySize)
  weightEl?.addEventListener('input', applyWeight)
  italicEl?.addEventListener('change', applyItalic)
  styleEl?.addEventListener('change', applyStyle)

  // Mark per-row overrides so applySample skips them on subsequent
  // typing in the global input.
  document.addEventListener('input', e => {
    if (e.target.classList?.contains('font-preview-line')) {
      e.target.dataset.overridden = 'true'
    }
  })

  // ---------------------------------------------------------------------
  // 4. Category filter (chip strip + desktop rail).
  // ---------------------------------------------------------------------
  let activeCategory = ''

  function applyFilter() {
    document.querySelectorAll('.font-family').forEach(card => {
      const cat = card.getAttribute('data-family-category') ?? 'other'
      const visible = !activeCategory || cat === activeCategory
      card.hidden = !visible
    })
    // Sync chip + rail aria states.
    if (chipsEl) {
      chipsEl.querySelectorAll('.font-chip').forEach(b => {
        b.dataset.active = (b.getAttribute('data-category') ?? '') === activeCategory ? 'true' : 'false'
      })
    }
    if (railListEl) {
      railListEl.querySelectorAll('.fonts-rail__btn').forEach(b => {
        b.dataset.active = (b.getAttribute('data-category') ?? '') === activeCategory ? 'true' : 'false'
      })
    }
  }

  if (chipsEl) {
    chipsEl.addEventListener('click', e => {
      const btn = e.target.closest('.font-chip')
      if (!btn) return
      activeCategory = btn.getAttribute('data-category') ?? ''
      applyFilter()
    })
  }
  if (railListEl) {
    railListEl.addEventListener('click', e => {
      const btn = e.target.closest('.fonts-rail__btn')
      if (!btn) return
      activeCategory = btn.getAttribute('data-category') ?? ''
      applyFilter()
    })
  }

  // ---------------------------------------------------------------------
  // 5. Mobile sticky bottom CTA.
  // ---------------------------------------------------------------------
  if (bottomAll) {
    bottomAll.addEventListener('click', e => {
      e.preventDefault()
      grid?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }
  // The per-family download CTA is updated to the most-recently-clicked
  // family card. Lightweight contextual primary action.
  if (bottomCta) {
    document.addEventListener('click', e => {
      const card = e.target.closest('.font-family')
      if (!card) return
      const familyId = card.getAttribute('data-family-id')
      bottomCta.hidden = false
      bottomCta.href = `/api/fonts/family/${encodeURIComponent(familyId)}.zip`
      bottomCta.textContent = `Download ${card.querySelector('.font-family__title')?.textContent ?? 'family'}`
    })
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------
  function groupByVariant(files) {
    const groups = new Map()
    for (const file of files) {
      const key = file.variant ?? '__default__'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(file)
    }
    return groups
  }

  // Pick the file that best matches the global state for a given family.
  // Strategy:
  //   1. Pick a variant. If the user picked a specific style and the
  //      family has it, use it. Otherwise auto-fallback in the order
  //      Text → Default → Display → Rounded → Large → Medium → Small
  //      → ExtraLarge.
  //   2. Variable file always wins within the chosen variant — it
  //      covers every weight via the `wght` axis (and optical-size via
  //      `opsz` for families that ship that axis).
  //   3. Static files: pick the file whose weight is nearest to the
  //      requested numeric weight, preferring italic when the toggle
  //      is on (fall back to upright if no italic ships).
  function pickFileForGlobals(_family, groups, state) {
    const autoPriority = ['Text', '__default__', 'Display', 'Rounded', 'Large', 'Medium', 'Small', 'ExtraLarge']
    let variant
    if (state.style && state.style !== 'auto' && groups.has(state.style)) {
      variant = state.style
    } else {
      variant = autoPriority.find(v => groups.has(v)) ?? VARIANT_ORDER.find(v => groups.has(v))
    }
    const files = variant ? groups.get(variant) : []
    if (files.length === 0) return null

    const variable = files.find(f => f.is_variable)
    if (variable) return variable

    const target = state.weight
    const wantItalic = state.italic
    const candidates = files.filter(f => (f.italic ?? false) === wantItalic)
    const pool = candidates.length ? candidates : files
    let best = pool[0]
    let bestDelta = Number.POSITIVE_INFINITY
    for (const file of pool) {
      const w = WEIGHT_NUMERIC[file.weight] ?? 400
      const delta = Math.abs(w - target)
      if (delta < bestDelta) {
        best = file
        bestDelta = delta
      }
    }
    return best
  }

  function formatHint(format) {
    switch ((format || '').toLowerCase()) {
      case 'ttf': return 'truetype'
      case 'otf': return 'opentype'
      case 'ttc': return 'collection'
      default: return ''
    }
  }
}

init()
