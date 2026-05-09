import { describe, expect, test } from 'bun:test'
import { _test } from '../../src/resources/symbol-pdf-to-svg.js'

const encoder = new TextEncoder()

describe('symbol PDF to SVG conversion', () => {
  test('tracks alpha and fill rule per PDF fill operation', () => {
    const fills = _test.parseContentStream(encoder.encode([
      '/GsCut gs',
      '0 0 m 10 0 l 10 10 l 0 10 l h f',
      '/GsOn gs',
      '1 1 m 2 1 l 2 2 l 1 2 l h f*',
    ].join(' ')), {
      GsCut: 0,
      GsOn: 1,
    })

    expect(fills).toHaveLength(2)
    expect(fills[0].alpha).toBe(0)
    expect(fills[0].fillRule).toBe('nonzero')
    expect(fills[1].alpha).toBe(1)
    expect(fills[1].fillRule).toBe('evenodd')
  })

  test('emits alpha-zero nonzero cuts as luminance masks instead of even-odd clip subtraction', () => {
    const svg = _test.assembleSvg([
      visible(rect(0, 0, 40, 40)),
      cut([rect(5, 5, 20, 20), rect(15, 15, 20, 20)], 'nonzero'),
      visible(rect(10, 10, 5, 5)),
    ], { name: 'overlapping-cut', pointSize: 64, color: '#123456' })

    expect(svg).toContain('<mask ')
    expect(svg).toContain('mask-type="luminance"')
    expect(svg).toContain('style="mask-type:luminance"')
    expect(svg).not.toContain('<clipPath')
    expect(svg).not.toContain('clip-rule="evenodd"')
    expect(svg).toContain('fill="#000"/></mask>')
    expect(svg).toContain('<g mask="url(#')

    const groupStart = svg.indexOf('<g mask=')
    const groupEnd = svg.indexOf('</g>', groupStart)
    const foreground = svg.indexOf('<path d=', groupEnd)
    expect(groupStart).toBeGreaterThan(-1)
    expect(groupEnd).toBeGreaterThan(groupStart)
    expect(foreground).toBeGreaterThan(groupEnd)
  })

  test('preserves even-odd semantics only for alpha-zero fills that used f-star', () => {
    const svg = _test.assembleSvg([
      visible(rect(0, 0, 40, 40)),
      cut([rect(5, 5, 30, 30), rect(15, 15, 10, 10)], 'evenodd'),
    ], { name: 'evenodd-cut', pointSize: 64, color: '#123456' })

    expect(svg).toContain('<mask ')
    expect(svg).toContain('<path d="')
    expect(svg).toContain('fill="#000" fill-rule="evenodd"')
    expect(svg).not.toContain('<clipPath')
  })
})

function visible(subpath, fillRule = 'nonzero') {
  return { alpha: 1, fillRule, subpaths: [subpath] }
}

function cut(subpaths, fillRule) {
  return { alpha: 0, fillRule, subpaths }
}

function rect(x, y, w, h) {
  return {
    commands: [
      { op: 'M', args: [x, y] },
      { op: 'L', args: [x + w, y] },
      { op: 'L', args: [x + w, y + h] },
      { op: 'L', args: [x, y + h] },
      { op: 'Z' },
    ],
  }
}
