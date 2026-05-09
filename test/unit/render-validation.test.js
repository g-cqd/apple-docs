import { describe, test, expect } from 'bun:test'
import {
  validateFontText,
  validateSymbolParams,
  FONT_TEXT_MAX_CHARS,
  ALLOWED_SYMBOL_SIZES,
} from '../../src/web/routes/render-validation.js'

describe('validateFontText', () => {
  test('null defaults to "Typography"', () => {
    expect(validateFontText(null)).toEqual({ ok: true, value: 'Typography' })
  })

  test('empty string defaults to "Typography"', () => {
    expect(validateFontText('')).toEqual({ ok: true, value: 'Typography' })
  })

  test('accepts a short string', () => {
    expect(validateFontText('Hello')).toEqual({ ok: true, value: 'Hello' })
  })

  test('accepts exactly FONT_TEXT_MAX_CHARS chars', () => {
    const text = 'a'.repeat(FONT_TEXT_MAX_CHARS)
    expect(validateFontText(text)).toEqual({ ok: true, value: text })
  })

  test('rejects FONT_TEXT_MAX_CHARS + 1 chars', () => {
    const text = 'a'.repeat(FONT_TEXT_MAX_CHARS + 1)
    const result = validateFontText(text)
    expect(result.ok).toBe(false)
    expect(result.error).toContain(String(FONT_TEXT_MAX_CHARS))
  })
})

describe('validateSymbolParams', () => {
  test('all unset → empty value bag', () => {
    expect(validateSymbolParams({})).toEqual({ ok: true, value: {} })
  })

  test('valid full bundle round-trips', () => {
    const result = validateSymbolParams({
      size: '24',
      color: '#FF8800',
      background: '00FF00',
      weight: 'Bold',
      scale: 'Large',
    })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      size: '24',
      color: '#FF8800',
      background: '00FF00',
      weight: 'bold',
      scale: 'large',
    })
  })

  test('rejects size off the allowlist', () => {
    const result = validateSymbolParams({ size: '99' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('size')
  })

  test('rejects non-numeric size', () => {
    const result = validateSymbolParams({ size: 'huge' })
    expect(result.ok).toBe(false)
  })

  test('accepts every allowlisted size', () => {
    for (const size of ALLOWED_SYMBOL_SIZES) {
      expect(validateSymbolParams({ size: String(size) }).ok).toBe(true)
    }
  })

  test('rejects color with bad characters', () => {
    expect(validateSymbolParams({ color: 'red' }).ok).toBe(false)
    expect(validateSymbolParams({ color: '#GGGGGG' }).ok).toBe(false)
    expect(validateSymbolParams({ color: '#FF88' }).ok).toBe(false)
    expect(validateSymbolParams({ color: 'javascript:alert(1)' }).ok).toBe(false)
  })

  test('accepts color with or without leading #', () => {
    expect(validateSymbolParams({ color: '#abcdef' }).ok).toBe(true)
    expect(validateSymbolParams({ color: 'abcdef' }).ok).toBe(true)
  })

  test('rejects unknown weight', () => {
    expect(validateSymbolParams({ weight: 'extrabold' }).ok).toBe(false)
  })

  test('rejects unknown scale', () => {
    expect(validateSymbolParams({ scale: 'extra-large' }).ok).toBe(false)
  })

  test('empty string treated as missing (no validation, no value)', () => {
    expect(validateSymbolParams({ size: '', color: '', weight: '' })).toEqual({
      ok: true,
      value: {},
    })
  })
})
