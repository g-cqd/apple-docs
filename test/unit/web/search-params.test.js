import { describe, expect, test } from 'bun:test'
import { parseSearchParams } from '../../../src/web/routes/search-params.js'
import { MAX_SEARCH_QUERY_CHARS, SEARCH_MAX_LIMIT, SEARCH_MAX_OFFSET } from '../../../src/lib/limits.js'

const parse = (query) => parseSearchParams(new URLSearchParams(query))

describe('parseSearchParams', () => {
  test('applies defaults when nothing is supplied', () => {
    expect(parse('q=view')).toEqual({ ok: true, limit: 50, offset: 0, year: null })
  })

  test('accepts in-range values', () => {
    expect(parse('q=a&limit=10&offset=20&year=2024')).toEqual({ ok: true, limit: 10, offset: 20, year: 2024 })
  })

  test.each(['-1', 'abc', '0', '1.5', '', ' 5', '5abc', '1e3', '+5'])('rejects limit=%j', (value) => {
    expect(parse(`q=a&limit=${encodeURIComponent(value)}`)).toMatchObject({ ok: false, parameter: 'limit' })
  })

  test('clamps an oversized limit instead of rejecting it', () => {
    expect(parse('q=a&limit=99999999')).toMatchObject({ ok: true, limit: SEARCH_MAX_LIMIT })
  })

  test('accepts limit at the cap and offset at its cap', () => {
    expect(parse(`q=a&limit=${SEARCH_MAX_LIMIT}&offset=${SEARCH_MAX_OFFSET}`)).toMatchObject({
      ok: true, limit: SEARCH_MAX_LIMIT, offset: SEARCH_MAX_OFFSET,
    })
  })

  test.each(['-1', 'x', `${SEARCH_MAX_OFFSET + 1}`, '1.0'])('rejects offset=%j', (value) => {
    expect(parse(`q=a&offset=${value}`)).toMatchObject({ ok: false, parameter: 'offset' })
  })

  test.each(['24', 'abcd', '20240', '-2024'])('rejects year=%j', (value) => {
    expect(parse(`q=a&year=${value}`)).toMatchObject({ ok: false, parameter: 'year' })
  })

  test('treats an empty year as absent', () => {
    expect(parse('q=a&year=')).toMatchObject({ ok: true, year: null })
  })

  test('rejects a query longer than the cap and accepts one exactly at the cap', () => {
    expect(parse(`q=${'a'.repeat(MAX_SEARCH_QUERY_CHARS)}`).ok).toBe(true)
    expect(parse(`q=${'a'.repeat(MAX_SEARCH_QUERY_CHARS + 1)}`)).toMatchObject({ ok: false, parameter: 'q' })
  })

  test('rejects the 50,000-character query from the pentest report', () => {
    expect(parse(`q=${'a'.repeat(50_000)}`)).toMatchObject({ ok: false, parameter: 'q' })
  })
})
