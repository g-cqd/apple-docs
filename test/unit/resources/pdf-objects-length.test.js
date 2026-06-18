// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { describe, expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { collectObjects, decodeStream } from '../../../src/resources/symbol-pdf-to-svg/pdf-objects.js'

// Synthetic PDF fragments. Real Apple-emitted symbol PDFs use both the
// literal `/Length N` form and the indirect-reference `/Length N gen R`
// form depending on the weight/scale variant; the indirect-ref case
// previously truncated streams mid-DEFLATE-block and triggered the
// "invalid stored block lengths" cascade in the prerender loop.

function buildPdf(parts) {
  // PDF is latin-1; the binary stream payload goes in as raw bytes,
  // surrounded by ASCII header / dict / trailer text.
  const encoder = new TextEncoder()
  const chunks = []
  for (const part of parts) {
    chunks.push(typeof part === 'string' ? encoder.encode(part) : part)
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function latin1(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

// Build a fresh zlib-wrapped DEFLATE stream per-test. `node:zlib.deflateSync`
// produces the same wire format Apple's `CGPDFContext` emits (zlib header
// `78 9c` / `78 01`); `Bun.deflateSync` emits raw DEFLATE which doesn't
// match the symbol-PDF format our decodeStream expects.
function deflate(payload) {
  return new Uint8Array(deflateSync(Buffer.from(payload)))
}

describe('collectObjects /Length handling', () => {
  test('literal /Length form slices the stream cleanly', () => {
    const compressed = deflate('hello pdf world')
    const bytes = buildPdf([
      '%PDF-1.4\n',
      '1 0 obj\n<< /Length ',
      String(compressed.length),
      ' /Filter /FlateDecode >>\nstream\n',
      compressed,
      '\nendstream\nendobj\n',
      '%%EOF\n',
    ])
    const text = latin1(bytes)
    const objects = collectObjects(text, bytes)
    const obj = objects.get('1 0')
    expect(obj).toBeDefined()
    expect(obj.stream.length).toBe(compressed.length)
    expect(latin1(decodeStream(obj))).toBe('hello pdf world')
  })

  test('indirect /Length resolves through the referenced object', () => {
    const payload = 'indirect length resolution should not truncate this stream'
    const compressed = deflate(payload)
    // /Length points to object 2; object 2's body is the literal byte count.
    const bytes = buildPdf([
      '%PDF-1.4\n',
      '1 0 obj\n<< /Length 2 0 R /Filter /FlateDecode >>\nstream\n',
      compressed,
      '\nendstream\nendobj\n',
      '2 0 obj\n',
      String(compressed.length),
      '\nendobj\n',
      '%%EOF\n',
    ])
    const text = latin1(bytes)
    const objects = collectObjects(text, bytes)
    const obj = objects.get('1 0')
    expect(obj).toBeDefined()
    expect(obj.stream.length).toBe(compressed.length)
    // The decoded payload round-trips: this is the assertion that proves the
    // previous regex-based extraction was truncating the stream.
    expect(latin1(decodeStream(obj))).toBe(payload)
  })

  test('missing /Length falls back to the endstream marker', () => {
    const payload = 'raw uncompressed body'
    const bytes = buildPdf(['%PDF-1.4\n', '1 0 obj\n<< /Type /Raw >>\nstream\n', payload, '\nendstream\nendobj\n', '%%EOF\n'])
    const text = latin1(bytes)
    const objects = collectObjects(text, bytes)
    const obj = objects.get('1 0')
    expect(obj).toBeDefined()
    expect(latin1(obj.stream)).toBe(payload)
  })
})
