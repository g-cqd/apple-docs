import { describe, expect, test } from 'bun:test'
import { contentDispositionAttachment } from '../../src/lib/http-content-disposition.js'

describe('contentDispositionAttachment (A24)', () => {
  test('plain ASCII filename produces both filename and filename*', () => {
    const result = contentDispositionAttachment('SF-Pro.zip')
    expect(result).toContain('attachment;')
    expect(result).toContain('filename="SF-Pro.zip"')
    expect(result).toContain("filename*=UTF-8''SF-Pro.zip")
  })

  test('preserves dots/dashes/parens in ASCII fallback', () => {
    const result = contentDispositionAttachment('init(foo:bar:).json')
    expect(result).toContain('filename="init(foo:bar:).json"')
  })

  test('strips quotes / backslash / semicolon / comma from ASCII fallback', () => {
    const result = contentDispositionAttachment('a"b\\c;d,e.txt')
    expect(result).toContain('filename="abcde.txt"')
    expect(result).not.toContain('"a"b')
    // UTF-8 form preserves the original via percent-encoding
    expect(result).toContain('a%22b%5Cc%3Bd%2Ce.txt')
  })

  test('non-ASCII filename mojibake-safe via filename*', () => {
    const result = contentDispositionAttachment('SF-Hebrew-עברית.zip')
    // ASCII fallback drops the Hebrew characters to underscores
    expect(result).toMatch(/filename="SF-Hebrew-_+\.zip"/)
    // UTF-8 form preserves them via percent-encoding
    expect(result).toContain("filename*=UTF-8''")
    expect(result).toContain(encodeURIComponent('עברית'))
  })

  test('empty input falls back to "download"', () => {
    const result = contentDispositionAttachment('')
    expect(result).toContain('filename="download"')
  })

  test('null/undefined input falls back to "download"', () => {
    expect(contentDispositionAttachment(null)).toContain('filename="download"')
    expect(contentDispositionAttachment(undefined)).toContain('filename="download"')
  })
})
