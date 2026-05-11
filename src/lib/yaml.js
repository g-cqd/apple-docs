/**
 * Serialize a flat object as YAML front matter.
 * Handles strings, numbers, booleans, and arrays of primitives.
 */
export function toFrontMatter(obj) {
  const lines = ['---']
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(v => quoteIfNeeded(String(v))).join(', ')}]`)
    } else {
      lines.push(`${key}: ${quoteIfNeeded(String(value))}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

function quoteIfNeeded(s) {
  if (s === '' || s === 'true' || s === 'false' || s === 'null' ||
      /^[\d.]+$/.test(s) || /[:{}[\],&*?|>!%#@`"']/.test(s) || s.includes('\n')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return s
}
