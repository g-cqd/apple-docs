// Pure formatting + DOM helpers for the symbols page. All exports are
// stateless so the controller can use them without threading globals.

export function readVar(root, name) {
  return getComputedStyle(root).getPropertyValue(name).trim()
}

export function normaliseHex(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/)
  if (!match) return null
  return `#${match[1].toLowerCase()}`
}

export function bindColorPair(picker, hex, onChange) {
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

// Many symbols share the same categories/keywords payload (e.g. every
// ".badge" variant of "person" carries the same {human} category). To
// give the metadata block something distinctive per symbol, decompose
// the dotted name into base + modifiers ("circle.fill" → base "circle"
// with modifier "fill").
export function describeComposition(name) {
  if (!name) return ''
  const parts = name.split('.').filter(Boolean)
  if (parts.length === 1) return ''
  const stem = parts[0]
  const modifiers = parts.slice(1)
  return `${stem} → ${modifiers.join(' → ')}`
}

export function formatAliases(aliases) {
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
export function formatAvailability(availability) {
  if (!availability || typeof availability !== 'object') return ''
  const platformOrder = ['iOS', 'iPadOS', 'macOS', 'watchOS', 'tvOS', 'visionOS']
  const seen = new Set(platformOrder)
  const ordered = [
    ...platformOrder.filter(p => availability[p]),
    ...Object.keys(availability).filter(p => !seen.has(p)),
  ]
  return ordered
    .map(p => availability[p] ? `${p} ${availability[p]}` : null)
    .filter(Boolean)
    .join(', ')
}

// Snap the page's computed text colour to a hex string suitable for the
// symbol-render API. The browser returns `rgb(r, g, b)` / `rgba(...)`
// from getComputedStyle even when CSS used a named colour. Falls back
// to `#000000` if the format is unexpected (e.g. `oklch()` on very new
// browsers).
export function resolvedThemeFg() {
  const raw = getComputedStyle(document.body).color || ''
  const m = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (!m) return '#000000'
  const hex = (n) => Number(n).toString(16).padStart(2, '0')
  return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`
}
