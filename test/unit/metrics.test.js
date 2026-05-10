import { describe, expect, test } from 'bun:test'
import { formatPrometheus, PROMETHEUS_CONTENT_TYPE } from '../../src/lib/metrics.js'

describe('formatPrometheus', () => {
  test('emits HELP and TYPE lines per metric', () => {
    const out = formatPrometheus([
      { name: 'apple_docs_test_total', help: 'test counter', type: 'counter', samples: [{ value: 7 }] },
    ])
    expect(out).toContain('# HELP apple_docs_test_total test counter')
    expect(out).toContain('# TYPE apple_docs_test_total counter')
    expect(out).toContain('apple_docs_test_total 7')
    expect(out.endsWith('\n')).toBe(true)
  })

  test('distinguishes counter and gauge in TYPE line', () => {
    const out = formatPrometheus([
      { name: 'cnt', help: 'c', type: 'counter', samples: [{ value: 1 }] },
      { name: 'gau', help: 'g', type: 'gauge', samples: [{ value: 2 }] },
    ])
    expect(out).toContain('# TYPE cnt counter')
    expect(out).toContain('# TYPE gau gauge')
  })

  test('coerces unknown type strings to gauge', () => {
    const out = formatPrometheus([
      { name: 'm', help: 'h', type: 'histogram', samples: [{ value: 1 }] },
    ])
    expect(out).toContain('# TYPE m gauge')
  })

  test('formats integer and floating-point values cleanly', () => {
    const out = formatPrometheus([
      { name: 'i', help: '', type: 'gauge', samples: [{ value: 42 }] },
      { name: 'f', help: '', type: 'gauge', samples: [{ value: 0.5 }] },
    ])
    expect(out).toContain('i 42')
    expect(out).toContain('f 0.5')
  })

  test('skips non-finite sample values (NaN, Infinity, null)', () => {
    const out = formatPrometheus([
      {
        name: 'm', help: '', type: 'gauge',
        samples: [
          { value: Number.NaN },
          { value: Number.POSITIVE_INFINITY },
          { value: Number.NEGATIVE_INFINITY },
          { value: null },
          { value: undefined },
          { value: 3 },
        ],
      },
    ])
    // The only emitted sample line should be the finite "3".
    const sampleLines = out.split('\n').filter(l => l.startsWith('m '))
    expect(sampleLines).toEqual(['m 3'])
  })

  test('emits HELP and TYPE even when samples are empty', () => {
    const out = formatPrometheus([
      { name: 'empty_metric', help: 'no samples yet', type: 'gauge', samples: [] },
    ])
    expect(out).toContain('# HELP empty_metric no samples yet')
    expect(out).toContain('# TYPE empty_metric gauge')
    // No sample line — only HELP/TYPE lines should reference the name.
    const sampleLines = out.split('\n').filter(l => l.length > 0 && !l.startsWith('#'))
    expect(sampleLines).toEqual([])
  })

  test('formats labels with key="value" pairs', () => {
    const out = formatPrometheus([
      {
        name: 'cache_hits',
        help: '',
        type: 'counter',
        samples: [
          { labels: { cache: 'search_docs' }, value: 5 },
          { labels: { cache: 'read_doc' }, value: 12 },
        ],
      },
    ])
    expect(out).toContain('cache_hits{cache="search_docs"} 5')
    expect(out).toContain('cache_hits{cache="read_doc"} 12')
  })

  test('escapes backslash and double-quote in label values per spec', () => {
    const out = formatPrometheus([
      {
        name: 'lbl', help: '', type: 'gauge',
        samples: [{ labels: { name: 'a"b\\c' }, value: 1 }],
      },
    ])
    expect(out).toContain('lbl{name="a\\"b\\\\c"} 1')
  })

  test('escapes newline in label values', () => {
    const out = formatPrometheus([
      {
        name: 'lbl', help: '', type: 'gauge',
        samples: [{ labels: { note: 'line1\nline2' }, value: 1 }],
      },
    ])
    expect(out).toContain('lbl{note="line1\\nline2"} 1')
  })

  test('drops null/undefined label values rather than emitting them literally', () => {
    const out = formatPrometheus([
      {
        name: 'lbl', help: '', type: 'gauge',
        samples: [{ labels: { a: 'x', b: null, c: undefined }, value: 1 }],
      },
    ])
    expect(out).toContain('lbl{a="x"} 1')
    expect(out).not.toContain('b=')
    expect(out).not.toContain('c=')
  })

  test('escapes backslash and newline in HELP lines', () => {
    const out = formatPrometheus([
      { name: 'm', help: 'back\\slash and\nnewline', type: 'gauge', samples: [{ value: 1 }] },
    ])
    expect(out).toContain('# HELP m back\\\\slash and\\nnewline')
  })

  test('returns empty string for empty input array', () => {
    expect(formatPrometheus([])).toBe('')
  })

  test('returns empty string for non-array input', () => {
    expect(formatPrometheus(null)).toBe('')
    expect(formatPrometheus(undefined)).toBe('')
    expect(formatPrometheus({})).toBe('')
  })

  test('skips malformed metric entries without throwing', () => {
    const out = formatPrometheus([
      null,
      { help: 'no name' },
      { name: 'ok', help: '', type: 'gauge', samples: [{ value: 9 }] },
    ])
    expect(out).toContain('ok 9')
  })

  test('exports the standard Prometheus content type', () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe('text/plain; version=0.0.4; charset=utf-8')
  })
})
