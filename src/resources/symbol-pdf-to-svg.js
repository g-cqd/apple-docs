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
 * destination-out cut-out against the previously-painted layers, and emit
 * SVG using internal `<mask>` elements. The output is pure vector at any size.
 *
 * The PDF subset we handle is exactly what Apple's CGContext PDF writer
 * emits: q/Q, cs, sc, gs, m/l/c/h, f. No text, no images, no shading, no
 * complex graphics state. Inline coordinates live in PDF user space (Y-up);
 * we Y-flip and translate into a (0,0)-anchored SVG viewBox so consumers
 * (CSS mask-image, <img src>, plain rendering) all behave consistently.
 *
 * Phase B decomposition: the PDF object-graph extraction lives in
 * symbol-pdf-to-svg/pdf-objects.js, the content-stream interpreter in
 * symbol-pdf-to-svg/content-stream.js, and the SVG-mask compositor in
 * symbol-pdf-to-svg/svg-emit.js. This file is the thin facade that wires
 * them in sequence.
 */

import {
  bytesToLatin1,
  collectObjects,
  decodeStream,
  findPage,
  resolveDict,
  resolveStreamObject,
} from './symbol-pdf-to-svg/pdf-objects.js'
import { parseContentStream } from './symbol-pdf-to-svg/content-stream.js'
import { assembleSvg } from './symbol-pdf-to-svg/svg-emit.js'

/**
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

export const _test = { parseContentStream, assembleSvg }
