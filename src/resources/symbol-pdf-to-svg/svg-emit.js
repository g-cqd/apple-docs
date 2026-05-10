// Compose the parsed PDF fills into an SVG that mirrors Apple's
// destination-out compositing. Visible (alpha>0) fills paint normally;
// alpha=0 fills wrap the previously-painted layers in a luminance mask
// so the cut geometry removes pixels from earlier layers (and only those
// — subsequent layers escape the cut and become subject to any later one).

export function assembleSvg(fills, opts) {
  const { name = '', pointSize = 128, color = 'currentColor', background = null } = opts

  // Compute the global bbox across every fill so we can normalise to a
  // (0,0)-anchored, Y-flipped viewBox.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const fill of fills) {
    for (const sub of fill.subpaths) {
      for (const cmd of sub.commands) {
        if (!cmd.args) continue
        for (let i = 0; i < cmd.args.length; i += 2) {
          const x = cmd.args[i]
          const y = cmd.args[i + 1]
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
  }
  if (!Number.isFinite(minX)) throw new Error('symbol PDF: empty geometry')
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const pad = span * 0.06
  const flipY = (y) => (maxY - y) + pad
  const flipX = (x) => (x - minX) + pad
  const vbW = (maxX - minX) + pad * 2
  const vbH = (maxY - minY) + pad * 2

  // Walk fills in painting order, building an SVG tree that mirrors Apple's
  // destination-out compositing. Each visible (alpha>0) fill paints on top
  // of whatever's already in the tree. Each alpha=0 fill carves pixels from
  // every visible layer painted so far, using the same fill rule Apple wrote
  // into the PDF content stream. We model that by wrapping the current tree
  // in a luminance mask: white keeps the previous tree, black removes the
  // cut geometry. Subsequent visible layers are appended outside that wrapper
  // so they correctly escape earlier cuts but become subject to any later
  // one. Examples:
  //   [V1]             → V1
  //   [V1, C1]         → <g mask=C1>V1</g>
  //   [V1, C1, V2]     → <g mask=C1>V1</g>, V2
  //   [V1, C1, V2, C2] → <g mask=C2><g mask=C1>V1</g>, V2</g>
  //
  // The older clip-path implementation encoded every cut as
  // `viewBoxRect ∪ cutPath` with even-odd parity. That is only correct for
  // even-odd cuts. Nonzero cuts with overlapping or nested contours can
  // accidentally re-add pixels, so masks are the more faithful primitive.
  const fillColor = String(color)
  const escapedName = escapeXml(name)
  const idBase = `c${(Math.random().toString(36).slice(2, 8))}`
  let defs = ''
  let nodes = []
  fills.forEach((fill, idx) => {
    if (fill.alpha > 0) {
      const d = subpathsToD(fill.subpaths, flipX, flipY)
      const ruleAttr = fillRuleAttr(fill.fillRule)
      nodes.push(`<path d="${d}" fill="${fillColor}"${ruleAttr}/>`)
    } else {
      if (nodes.length === 0) return
      const maskId = `${idBase}_${idx}`
      const cutD = subpathsToD(fill.subpaths, flipX, flipY)
      defs += `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${formatNumber(vbW)}" height="${formatNumber(vbH)}" mask-type="luminance" style="mask-type:luminance">`
        + `<rect x="0" y="0" width="${formatNumber(vbW)}" height="${formatNumber(vbH)}" fill="#fff"/>`
        + `<path d="${cutD}" fill="#000"${fillRuleAttr(fill.fillRule)}/>`
        + `</mask>`
      nodes = [`<g mask="url(#${maskId})">${nodes.join('')}</g>`]
    }
  })
  const body = nodes.join('')

  const bgRect = background
    ? `<rect x="0" y="0" width="${formatNumber(vbW)}" height="${formatNumber(vbH)}" fill="${escapeXml(background)}"/>`
    : ''
  const defsBlock = defs ? `<defs>${defs}</defs>` : ''
  const viewBox = `0 0 ${formatNumber(vbW)} ${formatNumber(vbH)}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pointSize}" height="${pointSize}" viewBox="${viewBox}" role="img" aria-label="${escapedName}">${defsBlock}${bgRect}${body}</svg>`
}

function subpathsToD(subpaths, flipX, flipY) {
  const parts = []
  for (const sub of subpaths) {
    for (const cmd of sub.commands) {
      if (cmd.op === 'Z') {
        parts.push('Z')
        continue
      }
      const args = cmd.args.slice()
      for (let i = 0; i < args.length; i += 2) {
        args[i] = flipX(args[i])
        args[i + 1] = flipY(args[i + 1])
      }
      parts.push(cmd.op + args.map(formatNumber).join(' '))
    }
  }
  return parts.join(' ')
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return '0'
  // 3-decimal precision is enough for sub-device-pixel accuracy at 2048pt
  // viewBox sizes; trim trailing zeros so the SVG stays compact.
  const s = n.toFixed(3)
  return s.replace(/\.?0+$/, '') || '0'
}

function fillRuleAttr(fillRule) {
  return fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ))
}
