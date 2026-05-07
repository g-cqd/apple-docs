import { inflateSync } from 'node:zlib'

/**
 * Convert a single-page SF Symbol PDF (as emitted by
 * `vectorGlyph.drawInContext:`) into a true vector SVG with full layer-cutout
 * fidelity.
 *
 * Why this exists: when Apple's private vectorGlyph code paints a symbol with
 * cut-out layers (xmark.bin.circle.fill, health.fill, circle.slash, …) it
 * uses kCGBlendModeDestinationOut. CGContext's PDF backend cannot record that
 * blend mode, so it serialises those layers as `/ca 0` (fully transparent)
 * fills. PDF-to-SVG converters (pdftocairo, mutool) correctly skip alpha-0
 * fills — but for our purposes those fills *are* the cut-out geometry, and
 * we need them. We parse the PDF ourselves, treat every alpha-0 fill as a
 * destination-out cut-out against the previously-painted layer, and emit
 * SVG using `<mask>` elements. The output is pure vector at any size.
 *
 * The PDF subset we handle is exactly what Apple's CGContext PDF writer
 * emits: q/Q, cs, sc, gs, m/l/c/h, f. No text, no images, no shading, no
 * complex graphics state. Inline coordinates live in PDF user space (Y-up);
 * we Y-flip and translate into a (0,0)-anchored SVG viewBox so consumers
 * (CSS mask-image, <img src>, plain rendering) all behave consistently.
 *
 * @param {Uint8Array} pdfBytes
 * @param {{ name?: string, pointSize?: number, color?: string, background?: string }} [opts]
 * @returns {string} SVG markup
 */
export function symbolPdfToSvg(pdfBytes, opts = {}) {
  const buffer = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes)
  const text = bytesToLatin1(buffer)
  const objects = collectObjects(text, buffer)
  const page = findPage(objects)
  if (!page) throw new Error('symbol PDF: no /Type /Page object found')
  const resources = resolveDict(page.dict.Resources, objects)
  const extGState = resolveDict(resources?.ExtGState, objects) ?? {}
  const alphaByName = {}
  for (const [name, ref] of Object.entries(extGState)) {
    const dict = resolveDict(ref, objects)
    if (!dict) continue
    if (dict.ca !== undefined) alphaByName[name] = parseFloat(dict.ca)
  }
  const contentRef = page.dict.Contents
  const contentObj = resolveStreamObject(contentRef, objects)
  if (!contentObj) throw new Error('symbol PDF: no content stream')
  const stream = decodeStream(contentObj)
  const fills = parseContentStream(stream, alphaByName)
  if (fills.length === 0) throw new Error('symbol PDF: no fill operations')
  return assembleSvg(fills, opts)
}

/* ---------- PDF object extraction ---------- */

function bytesToLatin1(buf) {
  // latin-1 round-trip preserves every byte 1:1, which is what PDF text
  // assumes for non-stream content. Streams are still read from the original
  // Uint8Array via byte offsets recorded here.
  let s = ''
  const chunk = 0x10000
  for (let i = 0; i < buf.length; i += chunk) {
    s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + chunk, buf.length)))
  }
  return s
}

function collectObjects(text, bytes) {
  const objects = new Map()
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let match
  while ((match = re.exec(text)) !== null) {
    const id = `${match[1]} ${match[2]}`
    const headerEnd = match.index + match[0].length
    const endObj = text.indexOf('endobj', headerEnd)
    if (endObj < 0) continue
    const body = text.slice(headerEnd, endObj)
    const streamStart = body.indexOf('stream')
    let dictText = body
    let stream = null
    if (streamStart >= 0) {
      dictText = body.slice(0, streamStart)
      // The content after "stream\n" is raw bytes; locate it back in the
      // original Uint8Array by absolute offset so binary data isn't mangled
      // by the latin-1 decode round-trip above.
      let absStart = headerEnd + streamStart + 'stream'.length
      // Per spec, "stream" is followed by either CRLF or a single LF.
      if (text.charCodeAt(absStart) === 0x0d) absStart++
      if (text.charCodeAt(absStart) === 0x0a) absStart++
      // Prefer the declared `/Length` field — Flate-compressed streams can
      // legitimately end with a 0x0A byte, and a back-search-then-trim
      // heuristic would lop that byte off and leave inflate with truncated
      // input ("unexpected end of file"). Length is mandatory in the dict.
      const lengthMatch = dictText.match(/\/Length\s+(\d+)/)
      let absEnd
      if (lengthMatch) {
        absEnd = absStart + parseInt(lengthMatch[1], 10)
      } else {
        const endStreamRel = body.indexOf('endstream', streamStart)
        absEnd = headerEnd + endStreamRel
        while (absEnd > absStart && (bytes[absEnd - 1] === 0x0a || bytes[absEnd - 1] === 0x0d)) {
          absEnd--
        }
      }
      stream = bytes.subarray(absStart, absEnd)
    }
    const dict = parseDictionary(dictText)
    objects.set(id, { id, dict, stream })
  }
  return objects
}

function parseDictionary(text) {
  // Minimal PDF dictionary parser. We only need to extract the entries that
  // appear in CGContext-emitted PDFs: simple names, numbers, indirect refs,
  // arrays of numbers, and nested dictionaries. Strings, hex strings, and
  // streams aren't expected here.
  const start = text.indexOf('<<')
  if (start < 0) return {}
  let i = start + 2
  const out = {}
  while (i < text.length) {
    skipWs(text, i, value => { i = value })
    if (text.startsWith('>>', i)) break
    if (text[i] !== '/') { i++; continue }
    i++
    const keyStart = i
    while (i < text.length && !/[\s/<>\[\]]/.test(text[i])) i++
    const key = text.slice(keyStart, i)
    skipWs(text, i, value => { i = value })
    if (text.startsWith('<<', i)) {
      const endNested = findMatching(text, i, '<<', '>>')
      out[key] = parseDictionary(text.slice(i, endNested + 2))
      i = endNested + 2
    } else if (text[i] === '[') {
      const endArr = text.indexOf(']', i)
      out[key] = text.slice(i + 1, endArr).trim()
      i = endArr + 1
    } else if (text[i] === '/') {
      i++
      const nameStart = i
      while (i < text.length && !/[\s/<>\[\]]/.test(text[i])) i++
      out[key] = '/' + text.slice(nameStart, i)
    } else {
      const tokenStart = i
      while (i < text.length && !/[\s/<>\[\]]/.test(text[i])) i++
      let token = text.slice(tokenStart, i).trim()
      // Indirect reference: "<obj> <gen> R"
      const refMatch = token.match(/^(\d+)$/)
      if (refMatch) {
        const after = text.slice(i)
        const refRest = after.match(/^\s+(\d+)\s+R\b/)
        if (refRest) {
          out[key] = { ref: `${refMatch[1]} ${refRest[1]}` }
          i += refRest[0].length
        } else {
          out[key] = parseFloat(token)
        }
      } else if (/^-?\d+(?:\.\d+)?$/.test(token)) {
        out[key] = parseFloat(token)
      } else {
        out[key] = token
      }
    }
  }
  return out
}

function skipWs(text, start, set) {
  let i = start
  while (i < text.length && /[\s\r\n]/.test(text[i])) i++
  set(i)
}

function findMatching(text, start, open, close) {
  let depth = 1
  let i = start + open.length
  while (i < text.length && depth > 0) {
    if (text.startsWith(open, i)) { depth++; i += open.length }
    else if (text.startsWith(close, i)) { depth--; if (depth === 0) return i; i += close.length }
    else i++
  }
  return text.length - close.length
}

function findPage(objects) {
  for (const obj of objects.values()) {
    if (obj.dict?.Type === '/Page') return obj
  }
  return null
}

function resolveDict(value, objects) {
  if (!value) return null
  if (typeof value === 'object' && value !== null && 'ref' in value) {
    return objects.get(value.ref)?.dict ?? null
  }
  if (typeof value === 'object') return value
  return null
}

function resolveStreamObject(value, objects) {
  if (!value) return null
  if (typeof value === 'object' && 'ref' in value) {
    return objects.get(value.ref) ?? null
  }
  return null
}

function decodeStream(obj) {
  const filter = obj.dict.Filter
  if (filter === '/FlateDecode') return inflateSync(obj.stream)
  if (!filter) return obj.stream
  throw new Error(`symbol PDF: unsupported stream filter ${filter}`)
}

/* ---------- Content stream walk ---------- */

function parseContentStream(buffer, alphaByName) {
  const text = bytesToLatin1(buffer)
  const tokens = tokenize(text)
  const operands = []
  const fills = []
  let path = []
  let currentX = 0
  let currentY = 0
  const stack = [{ alpha: 1 }]
  const top = () => stack[stack.length - 1]

  const closeFill = () => {
    if (path.length === 0) return
    fills.push({ subpaths: path, alpha: top().alpha })
    path = []
  }
  const startSubpath = (x, y) => {
    path.push({ commands: [{ op: 'M', args: [x, y] }] })
    currentX = x
    currentY = y
  }
  const appendCommand = (cmd) => {
    if (path.length === 0) return
    path[path.length - 1].commands.push(cmd)
  }

  for (const token of tokens) {
    if (token.type === 'number') {
      operands.push(token.value)
      continue
    }
    if (token.type === 'name') {
      operands.push(token.value)
      continue
    }
    const op = token.value
    switch (op) {
      case 'q': stack.push({ ...top() }); break
      case 'Q': if (stack.length > 1) stack.pop(); break
      case 'gs': {
        const name = operands[0]
        if (typeof name === 'string' && name.startsWith('/')) {
          const alpha = alphaByName[name.slice(1)]
          if (alpha !== undefined) top().alpha = alpha
        }
        break
      }
      case 'cm':
        // Apple's PDFs emit identity here; we still consume operands so the
        // subsequent path data isn't misread.
        break
      case 'cs': case 'sc': case 'scn': case 'CS': case 'SC': case 'SCN':
      case 'rg': case 'RG': case 'g': case 'G': case 'k': case 'K':
        // Color is meaningless for our currentColor-driven SVG output.
        break
      case 'm':
        startSubpath(operands[0], operands[1])
        break
      case 'l':
        appendCommand({ op: 'L', args: [operands[0], operands[1]] })
        currentX = operands[0]; currentY = operands[1]
        break
      case 'c':
        appendCommand({ op: 'C', args: operands.slice(0, 6) })
        currentX = operands[4]; currentY = operands[5]
        break
      case 'v':
        appendCommand({ op: 'C', args: [currentX, currentY, operands[0], operands[1], operands[2], operands[3]] })
        currentX = operands[2]; currentY = operands[3]
        break
      case 'y':
        appendCommand({ op: 'C', args: [operands[0], operands[1], operands[2], operands[3], operands[2], operands[3]] })
        currentX = operands[2]; currentY = operands[3]
        break
      case 're': {
        const [x, y, w, h] = operands
        path.push({ commands: [
          { op: 'M', args: [x, y] },
          { op: 'L', args: [x + w, y] },
          { op: 'L', args: [x + w, y + h] },
          { op: 'L', args: [x, y + h] },
          { op: 'Z' },
        ] })
        currentX = x; currentY = y
        break
      }
      case 'h':
        appendCommand({ op: 'Z' })
        break
      case 'f': case 'F': case 'f*':
        if (op === 'f*') for (const sp of path) sp.fillRule = 'evenodd'
        closeFill()
        break
      case 'B': case 'B*': case 'b': case 'b*':
        if (op.includes('*')) for (const sp of path) sp.fillRule = 'evenodd'
        if (op === 'b' || op === 'b*') appendCommand({ op: 'Z' })
        closeFill()
        break
      case 'n': case 'S': case 's':
        // Stroke-only or no-paint: drop the path.
        path = []
        break
      default:
        break
    }
    operands.length = 0
  }
  return fills
}

function tokenize(text) {
  const tokens = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '%') {
      const newline = text.indexOf('\n', i)
      i = newline < 0 ? text.length : newline + 1
      continue
    }
    if (/\s/.test(ch)) { i++; continue }
    if (ch === '/') {
      const start = i
      i++
      while (i < text.length && !/[\s/\[\](){}<>]/.test(text[i])) i++
      tokens.push({ type: 'name', value: text.slice(start, i) })
      continue
    }
    if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) {
      const start = i
      i++
      while (i < text.length && /[0-9.\-+eE]/.test(text[i])) i++
      const slice = text.slice(start, i)
      const num = Number(slice)
      if (Number.isFinite(num)) {
        tokens.push({ type: 'number', value: num })
        continue
      }
      tokens.push({ type: 'op', value: slice })
      continue
    }
    if (/[A-Za-z]/.test(ch) || ch === '*' || ch === "'" || ch === '"') {
      const start = i
      i++
      while (i < text.length && /[A-Za-z0-9*'"]/.test(text[i])) i++
      tokens.push({ type: 'op', value: text.slice(start, i) })
      continue
    }
    // Skip anything else (`[`, `]`, `(`, `)`, etc.) — none appear in our
    // content streams.
    i++
  }
  return tokens
}

/* ---------- SVG assembly ---------- */

function assembleSvg(fills, opts) {
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
  // destination-out compositing exactly. Each visible (alpha>0) fill paints
  // on top of whatever's already in the tree. Each alpha=0 fill is a
  // destination-out blend — it carves pixels from *every* visible layer
  // painted so far, regardless of which visible layer drew them. We model
  // that by wrapping the entire current tree in a `<g clip-path="…">` at
  // every cut; subsequent visible layers are appended outside that wrapper
  // so they correctly escape earlier cuts but become subject to any later
  // one. Examples:
  //   [V1]             → V1
  //   [V1, C1]         → <g clip-path=C1>V1</g>
  //   [V1, C1, V2]     → <g clip-path=C1>V1</g>, V2
  //   [V1, C1, V2, C2] → <g clip-path=C2><g clip-path=C1>V1</g>, V2</g>
  //
  // We use clip-path instead of `<mask>` because clip-paths are purely
  // geometric: identical results whether the SVG is rendered inline,
  // through `<img>`, or as a CSS `mask-image` source. Masks rely on alpha
  // vs. luminance interpretation, which differs by context.
  const fillColor = String(color)
  const escapedName = escapeXml(name)
  const idBase = `c${(Math.random().toString(36).slice(2, 8))}`
  let defs = ''
  let nodes = []
  const vbRect = `M0 0H${formatNumber(vbW)}V${formatNumber(vbH)}H0Z`
  fills.forEach((fill, idx) => {
    if (fill.alpha > 0) {
      const d = subpathsToD(fill.subpaths, flipX, flipY)
      const ruleAttr = fill.subpaths.some(sp => sp.fillRule === 'evenodd') ? ' fill-rule="evenodd"' : ''
      nodes.push(`<path d="${d}" fill="${fillColor}"${ruleAttr}/>`)
    } else {
      if (nodes.length === 0) return
      const clipId = `${idBase}_${idx}`
      const cutD = subpathsToD(fill.subpaths, flipX, flipY)
      // clip-rule="evenodd" + (viewBox rect ∪ cut shape) = inside-the-rect
      // minus inside-the-cut. The rect covers the whole canvas so any
      // subsequent visible layer it wraps survives the clip outside the
      // cut shape.
      defs += `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">`
        + `<path d="${vbRect} ${cutD}" clip-rule="evenodd"/>`
        + `</clipPath>`
      nodes = [`<g clip-path="url(#${clipId})">${nodes.join('')}</g>`]
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

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ))
}
