// Fonts page (P7) — Google-Fonts-style live tester. Single global
// sample-text input + size slider drive every family preview through CSS
// custom props (`--sample-text`, `--sample-size`) and `content` on
// pseudo-elements, so changing the sample never touches a per-family DOM.
// Per-row inline-edit override keeps the Google "Styles table" pattern.
//
// Each family card renders one variant block per variant present
// (Display/Text/Rounded/ExtraLarge/Large/Medium/Small/Default), with a
// row of weight pills (or a slider when variable axes are present), a
// standalone iOS-style italic switch, and per-axis sliders with numeric
// readouts. Tag chips render in their own visual style (Adobe pattern):
// "Sans-serif" set in a sans face, "Serif" in serif, "Monospace" in mono.

(function () {
  const VARIANT_ORDER = ['Display', 'Text', 'Rounded', 'ExtraLarge', 'Large', 'Medium', 'Small', '__default__']
  const WEIGHT_ORDER = ['Ultralight', 'Thin', 'Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'Heavy', 'Black']

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
  const chipsEl = document.getElementById('fonts-chips')
  const railListEl = document.getElementById('fonts-rail-list')
  const grid = document.getElementById('font-family-grid')
  const bottomCta = document.getElementById('fonts-bottom-bar-cta')
  const bottomAll = document.getElementById('fonts-bottom-bar-all')
  const root = document.querySelector('.fonts-page') || document.body

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
  // 2. Per-family card render.
  // ---------------------------------------------------------------------
  document.querySelectorAll('.font-family').forEach(card => {
    const familyId = card.getAttribute('data-family-id')
    const family = families.find(f => f.id === familyId)
    if (!family) return
    const variantsEl = card.querySelector('[data-variants]')
    const previewEl = card.querySelector('[data-preview]')

    const groups = groupByVariant(family.files)
    const orderedVariants = VARIANT_ORDER.filter(v => groups.has(v))
    const state = {
      variant: orderedVariants[0],
      weight: pickInitialWeight(groups.get(orderedVariants[0])),
      italic: false,
      axes: {},
      // Per-row override map: variantWeight => string (overrides the
      // global sample text for that one preview row).
      overrides: new Map(),
    }

    const previewLine = document.createElement('div')
    previewLine.className = 'font-preview-line'
    previewLine.contentEditable = 'true'
    previewLine.spellcheck = false
    previewLine.setAttribute('aria-label', 'Sample text — click to edit')
    previewLine.addEventListener('input', () => {
      // Per-row override: stash the override so the global sample doesn’t
      // overwrite it. Empty string clears the override.
      state.overrides.set('preview', previewLine.textContent || '')
    })
    previewEl.appendChild(previewLine)

    function refreshPreview() {
      const file = pickFile(groups, state)
      if (!file) {
        previewLine.style.fontFamily = 'system-ui, sans-serif'
        previewLine.dataset.fileId = ''
      } else {
        previewLine.style.fontFamily = `"${cssNameByFileId.get(file.id)}", system-ui, sans-serif`
        previewLine.style.fontStyle = state.italic ? 'italic' : 'normal'
        previewLine.style.fontWeight = state.weight ? weightCssValue(state.weight) : 'normal'
        // Variable axes → font-variation-settings.
        if (Object.keys(state.axes).length) {
          previewLine.style.fontVariationSettings = Object.entries(state.axes)
            .map(([tag, value]) => `"${tag}" ${value}`)
            .join(', ')
        } else {
          previewLine.style.fontVariationSettings = ''
        }
        previewLine.dataset.fileId = file.id
      }
      // Apply current sample text unless a per-row override is set.
      if (!state.overrides.has('preview')) {
        previewLine.textContent = sampleEl.value || 'Reading Apple docs in good type.'
      }
    }

    function rerender() {
      variantsEl.replaceChildren()
      for (const variant of orderedVariants) {
        const block = document.createElement('section')
        block.className = 'font-variant'
        block.dataset.variant = variant
        if (orderedVariants.length > 1) {
          const head = document.createElement('header')
          head.className = 'font-variant__header'
          const title = document.createElement('h3')
          title.className = 'font-variant__title'
          title.textContent = variant === '__default__' ? family.display_name : variant
          head.appendChild(title)
          block.appendChild(head)
        }

        const files = groups.get(variant)
        const weights = orderWeights(files)
        const hasItalic = files.some(f => f.italic)
        const variableFile = files.find(f => f.is_variable)

        // Variable: continuous slider for weight (Google pattern). Static:
        // pills.
        if (variableFile && variableFile.axes?.length) {
          const axisPanel = document.createElement('div')
          axisPanel.className = 'font-variant__axes'
          for (const axis of variableFile.axes) {
            axisPanel.appendChild(buildAxisSlider(axis, state, () => {
              state.variant = variant
              state.weight = '__variable__'
              refreshPreview()
            }))
          }
          block.appendChild(axisPanel)
        } else {
          const pills = document.createElement('div')
          pills.className = 'font-variant__pills'
          for (const weight of weights) {
            const target = files.find(f => f.weight === weight && (state.italic ? f.italic : !f.italic))
            const pill = document.createElement('button')
            pill.type = 'button'
            pill.className = 'font-pill'
            pill.dataset.weight = weight
            pill.dataset.variant = variant
            pill.disabled = !target
            pill.setAttribute('aria-pressed', state.variant === variant && state.weight === weight ? 'true' : 'false')
            pill.style.fontWeight = weightCssValue(weight)
            pill.style.fontStyle = state.italic ? 'italic' : 'normal'
            if (target) {
              pill.style.fontFamily = `"${cssNameByFileId.get(target.id)}", system-ui, sans-serif`
              const sourceBadge = document.createElement('span')
              sourceBadge.className = `font-pill__source font-pill__source--${target.source}`
              sourceBadge.title = target.source === 'remote' ? 'Downloaded from Apple' : 'System-installed'
              sourceBadge.textContent = target.source === 'remote' ? '↓' : '○'
              pill.appendChild(sourceBadge)
            }
            const label = document.createElement('span')
            label.className = 'font-pill__label'
            label.textContent = weight
            pill.appendChild(label)
            pill.addEventListener('click', () => {
              if (!target) return
              state.variant = variant
              state.weight = weight
              rerender()
              refreshPreview()
            })
            pills.appendChild(pill)
          }
          block.appendChild(pills)
        }

        if (hasItalic) {
          const toggleWrap = document.createElement('label')
          toggleWrap.className = 'font-variant__italic'
          toggleWrap.innerHTML = '<input type="checkbox" role="switch"> <span>Italic</span>'
          const checkbox = toggleWrap.querySelector('input')
          checkbox.checked = state.italic
          checkbox.addEventListener('change', () => {
            state.italic = checkbox.checked
            rerender()
            refreshPreview()
          })
          block.appendChild(toggleWrap)
        }

        variantsEl.appendChild(block)
      }
    }

    rerender()
    refreshPreview()
  })

  // ---------------------------------------------------------------------
  // 3. Global sample text + size, propagated by JS (CSS vars surface
  //    `--sample-text` for any future static markup that wants it).
  // ---------------------------------------------------------------------
  function applySample() {
    const text = sampleEl.value || 'Reading Apple docs in good type.'
    root.style.setProperty('--sample-text', JSON.stringify(text))
    document.querySelectorAll('.font-preview-line').forEach(line => {
      // Skip overridden rows (contentEditable typed-into).
      if (line.dataset.overridden === 'true') return
      line.textContent = text
    })
  }

  function applySize() {
    const size = Number.parseInt(sizeEl.value, 10) || 48
    sizeValueEl.textContent = String(size)
    root.style.setProperty('--sample-size', `${size}px`)
    document.querySelectorAll('.font-preview-line').forEach(line => {
      line.style.fontSize = `${size}px`
    })
  }

  applySample()
  applySize()
  sampleEl.addEventListener('input', applySample)
  sizeEl.addEventListener('input', applySize)

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
  function buildAxisSlider(axis, state, onChange) {
    const wrap = document.createElement('label')
    wrap.className = 'font-axis'
    const label = document.createElement('span')
    label.className = 'font-axis__label'
    label.textContent = `${axisDisplayName(axis.tag)} `
    const value = document.createElement('span')
    value.className = 'font-axis__value'
    const initial = state.axes[axis.tag] ?? axis.default ?? axis.min ?? 400
    value.textContent = String(initial)
    label.appendChild(value)
    const range = document.createElement('input')
    range.type = 'range'
    range.min = String(axis.min ?? 100)
    range.max = String(axis.max ?? 900)
    range.step = '1'
    range.value = String(initial)
    range.setAttribute('aria-label', `${axisDisplayName(axis.tag)} axis`)
    range.addEventListener('input', () => {
      state.axes[axis.tag] = Number.parseFloat(range.value)
      value.textContent = range.value
      onChange()
    })
    wrap.append(label, range)
    state.axes[axis.tag] = initial
    return wrap
  }

  function axisDisplayName(tag) {
    const known = { wght: 'Weight', wdth: 'Width', opsz: 'Optical size', GRAD: 'Grade', slnt: 'Slant', ital: 'Italic' }
    return known[tag] ?? tag
  }

  function groupByVariant(files) {
    const groups = new Map()
    for (const file of files) {
      const key = file.variant ?? '__default__'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(file)
    }
    return groups
  }

  function orderWeights(files) {
    const present = new Set(files.map(f => f.weight).filter(Boolean))
    return WEIGHT_ORDER.filter(w => present.has(w))
  }

  function pickInitialWeight(files) {
    if (!files) return null
    if (files.some(f => f.weight === 'Regular')) return 'Regular'
    const ordered = orderWeights(files)
    return ordered[0] ?? '__variable__'
  }

  function pickFile(groups, state) {
    const files = groups.get(state.variant) ?? []
    if (state.weight === '__variable__') return files.find(f => f.is_variable) ?? null
    return (
      files.find(f => f.weight === state.weight && (state.italic ? f.italic : !f.italic))
      ?? files.find(f => f.weight === state.weight)
      ?? files[0]
      ?? null
    )
  }

  function weightCssValue(weight) {
    const map = {
      Ultralight: 100, Thin: 200, Light: 300, Regular: 400, Medium: 500,
      Semibold: 600, Bold: 700, Heavy: 800, Black: 900,
    }
    return map[weight] ?? 'normal'
  }

  function formatHint(format) {
    switch ((format || '').toLowerCase()) {
      case 'ttf': return 'truetype'
      case 'otf': return 'opentype'
      case 'ttc': return 'collection'
      default: return ''
    }
  }
})()
