// Fonts page — Google-Fonts-style live tester with structured variant
// groups. Each family renders one variant block per variant present
// (Display/Text/Rounded/ExtraLarge/Large/Medium/Small/Default), with a
// row of weight pills, an italic toggle, and a "variable" pill when a
// VF file lives alongside the statics. Each pill carries a small source
// badge (remote vs system).

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
    }

    const previewLine = document.createElement('div')
    previewLine.className = 'font-preview-line'
    previewEl.appendChild(previewLine)

    function refreshPreview() {
      const file = pickFile(groups, state)
      if (!file) {
        previewLine.style.fontFamily = 'system-ui, sans-serif'
        previewLine.dataset.fileId = ''
      } else {
        previewLine.style.fontFamily = `"${cssNameByFileId.get(file.id)}", system-ui, sans-serif`
        previewLine.style.fontStyle = state.italic ? 'italic' : 'normal'
        // Variable fonts still need an explicit font-weight to display the
        // selected weight. Static files have it baked in but setting it
        // doesn't hurt.
        previewLine.style.fontWeight = state.weight ? weightCssValue(state.weight) : 'normal'
        previewLine.dataset.fileId = file.id
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
          if (state.variant === variant && state.weight === weight) {
            pill.setAttribute('aria-pressed', 'true')
          } else {
            pill.setAttribute('aria-pressed', 'false')
          }
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

        if (variableFile) {
          const varPill = document.createElement('button')
          varPill.type = 'button'
          varPill.className = 'font-pill font-pill--variable'
          varPill.style.fontFamily = `"${cssNameByFileId.get(variableFile.id)}", system-ui, sans-serif`
          varPill.setAttribute('aria-pressed', state.variant === variant && state.weight === '__variable__' ? 'true' : 'false')
          varPill.appendChild(Object.assign(document.createElement('span'), {
            className: 'font-pill__label',
            textContent: 'Variable',
          }))
          if (variableFile.axes?.length) {
            const tags = variableFile.axes.map(ax => ax.tag).join(' ')
            varPill.title = `Variable axes: ${tags}`
          }
          varPill.addEventListener('click', () => {
            state.variant = variant
            state.weight = '__variable__'
            rerender()
            refreshPreview()
          })
          pills.appendChild(varPill)
        }

        block.appendChild(pills)

        if (hasItalic) {
          const toggleWrap = document.createElement('label')
          toggleWrap.className = 'font-variant__italic'
          toggleWrap.innerHTML = '<input type="checkbox"> <span>Italic</span>'
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

  function applySample() {
    const text = sampleEl.value || 'The quick brown fox jumps over the lazy dog'
    document.querySelectorAll('.font-preview-line').forEach(line => {
      line.textContent = text
    })
  }

  function applySize() {
    const size = Number.parseInt(sizeEl.value, 10) || 48
    sizeValueEl.textContent = String(size)
    document.querySelectorAll('.font-preview-line').forEach(line => {
      line.style.fontSize = `${size}px`
    })
  }

  applySample()
  applySize()
  sampleEl.addEventListener('input', applySample)
  sizeEl.addEventListener('input', applySize)

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
