// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { describe, expect, test } from 'bun:test'
import { decodeSectionContent, decodeSectionRow, encodeSectionContent } from '../../../src/storage/section-codec.js'

describe('section-codec', () => {
  test('roundtrips large content via zstd (stored as a BLOB)', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(200)
    const enc = encodeSectionContent(text)
    expect(enc).toBeInstanceOf(Uint8Array)
    expect(enc.length).toBeLessThan(Buffer.byteLength(text))
    expect(decodeSectionContent(enc)).toBe(text)
  })

  test('keeps tiny content as a plain string (no bloat)', () => {
    const enc = encodeSectionContent('abc')
    expect(typeof enc).toBe('string')
    expect(enc).toBe('abc')
    expect(decodeSectionContent(enc)).toBe('abc')
  })

  test('encode handles null / empty', () => {
    expect(encodeSectionContent(null)).toBe(null)
    expect(encodeSectionContent(undefined)).toBe(null)
    expect(encodeSectionContent('')).toBe('')
  })

  test('decode passes strings and null/undefined through unchanged', () => {
    expect(decodeSectionContent('hello')).toBe('hello')
    expect(decodeSectionContent(null)).toBe(null)
    expect(decodeSectionContent(undefined)).toBe(undefined)
  })

  test('decodeSectionRow decodes content_text + content_json in place', () => {
    const text = 'body '.repeat(500)
    const json = `[${'{"k":1},'.repeat(200)}{"k":2}]`
    const row = {
      content_text: encodeSectionContent(text),
      content_json: encodeSectionContent(json),
      sort_order: 0,
    }
    const out = decodeSectionRow(row)
    expect(out.content_text).toBe(text)
    expect(out.content_json).toBe(json)
    expect(out.sort_order).toBe(0)
  })

  test('decodeSectionRow is a no-op on an uncompressed (string) row', () => {
    const row = { content_text: 'plain text', content_json: '{"a":1}' }
    const out = decodeSectionRow(row)
    expect(out.content_text).toBe('plain text')
    expect(out.content_json).toBe('{"a":1}')
  })
})
