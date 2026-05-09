// PDF content-stream interpreter for the SF-Symbol-shaped subset emitted
// by CGContext: q/Q, cs, sc, gs, m/l/c/h/re, f, B/b. No text, no images,
// no shading. Extracts a flat list of `fill` records (subpaths + alpha
// + fill-rule) which the SVG-emit layer composes into masks for layer
// cut-outs.
//
// Pulled out of resources/symbol-pdf-to-svg.js as part of Phase B.

import { bytesToLatin1 } from './pdf-objects.js'

export function parseContentStream(buffer, alphaByName) {
  const text = bytesToLatin1(buffer)
  const tokens = tokenize(text)
  const operands = []
  const fills = []
  let path = []
  let currentX = 0
  let currentY = 0
  const stack = [{ alpha: 1 }]
  const top = () => stack[stack.length - 1]

  const closeFill = (fillRule = 'nonzero') => {
    if (path.length === 0) return
    fills.push({ subpaths: path, alpha: top().alpha, fillRule })
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
        closeFill(op === 'f*' ? 'evenodd' : 'nonzero')
        break
      case 'B': case 'B*': case 'b': case 'b*':
        if (op === 'b' || op === 'b*') appendCommand({ op: 'Z' })
        closeFill(op.includes('*') ? 'evenodd' : 'nonzero')
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
