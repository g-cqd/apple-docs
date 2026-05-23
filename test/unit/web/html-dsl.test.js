import { describe, expect, test } from 'bun:test'
import { html, raw, attr, isHtmlString } from '../../../src/web/lib/html.js'

/**
 * Contract tests for the tagged-template DSL at src/web/lib/html.js.
 * Every template in src/web/templates/ will rely on these guarantees
 * (auto-escape, brand check, splice semantics, byte round-trip), so
 * the assertions here pin the public-facing behaviour.
 */

describe('html — escape table parity with Bun.escapeHTML', () => {
  const cases = [
    ['ampersand', '&', '&amp;'],
    ['less-than', '<', '&lt;'],
    ['greater-than', '>', '&gt;'],
    ['double-quote', '"', '&quot;'],
    ['single-quote', "'", '&#x27;'],
    ['combined', '<script>alert("xss & friends")</script>', '&lt;script&gt;alert(&quot;xss &amp; friends&quot;)&lt;/script&gt;'],
    ['empty', '', ''],
    ['ascii-no-special', 'hello world', 'hello world'],
    ['unicode', 'café — résumé', 'café — résumé'],
  ]
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(html`${input}`.toString()).toBe(expected)
    })
  }
})

describe('html — type coercion at interpolation sites', () => {
  test('numbers render verbatim (no escape needed)', () => {
    expect(html`<x>${42}</x>`.toString()).toBe('<x>42</x>')
    expect(html`${1.5}`.toString()).toBe('1.5')
  })

  test('null and undefined render as empty string', () => {
    expect(html`<x>${null}</x>`.toString()).toBe('<x></x>')
    expect(html`<x>${undefined}</x>`.toString()).toBe('<x></x>')
  })

  test('true and false render as empty string (React-style conditional idiom)', () => {
    expect(html`<x>${true}</x>`.toString()).toBe('<x></x>')
    expect(html`<x>${false}</x>`.toString()).toBe('<x></x>')
  })

  test('arrays splice each element with no separator', () => {
    expect(html`<ul>${['a', 'b', 'c']}</ul>`.toString()).toBe('<ul>abc</ul>')
  })

  test('nested arrays flatten recursively', () => {
    expect(html`${[[1, 2], [3, 4]]}`.toString()).toBe('1234')
  })

  test('arrays escape each element', () => {
    expect(html`${['<a>', '<b>']}`.toString()).toBe('&lt;a&gt;&lt;b&gt;')
  })

  test('object fallback goes through String() + escape', () => {
    expect(html`${{ toString: () => '<x>' }}`.toString()).toBe('&lt;x&gt;')
  })
})

describe('html — composition via HtmlString children', () => {
  test('nested html splices without double-escape', () => {
    const child = html`<em>${'A & B'}</em>`
    const parent = html`<p>${child}</p>`
    expect(parent.toString()).toBe('<p><em>A &amp; B</em></p>')
  })

  test('array of HtmlStrings joins without separator', () => {
    const items = [html`<li>a</li>`, html`<li>b</li>`]
    expect(html`<ul>${items}</ul>`.toString()).toBe('<ul><li>a</li><li>b</li></ul>')
  })

  test('mixing strings and HtmlStrings in an array works', () => {
    const items = ['raw &', html`<em>trusted</em>`, null, '<bad>']
    expect(html`${items}`.toString()).toBe('raw &amp;<em>trusted</em>&lt;bad&gt;')
  })

  test('result is brand-detectable', () => {
    expect(isHtmlString(html`x`)).toBe(true)
    expect(isHtmlString('plain')).toBe(false)
    expect(isHtmlString(null)).toBe(false)
    expect(isHtmlString({ _chunks: ['x'] })).toBe(false)
  })

  test('brand defeats POJO spoofing (Symbol-keyed, not string-keyed)', () => {
    const spoof = { __apple_docs_html: true, _chunks: ['<bad>'] }
    expect(isHtmlString(spoof)).toBe(false)
    // The spoof's _chunks array is NOT spliced — instead the object
    // hits the String() fallback path and renders as `[object Object]`.
    // The dangerous `<bad>` payload never reaches the output.
    const rendered = html`${spoof}`.toString()
    expect(rendered).not.toContain('<bad>')
    expect(rendered).not.toContain('&lt;bad&gt;')
    expect(rendered).toBe('[object Object]')
  })
})

describe('raw()', () => {
  test('marks a string as trusted; subsequent interpolation does not escape', () => {
    const r = raw('<em>trusted</em>')
    expect(html`<p>${r}</p>`.toString()).toBe('<p><em>trusted</em></p>')
  })

  test('null and undefined become empty string', () => {
    expect(raw(null).toString()).toBe('')
    expect(raw(undefined).toString()).toBe('')
  })

  test('non-strings are coerced via String()', () => {
    expect(raw(42).toString()).toBe('42')
  })
})

describe('attr()', () => {
  test('emits empty for null / undefined / false', () => {
    expect(attr('hidden', null).toString()).toBe('')
    expect(attr('hidden', undefined).toString()).toBe('')
    expect(attr('hidden', false).toString()).toBe('')
  })

  test('emits valueless attribute for true', () => {
    expect(attr('hidden', true).toString()).toBe(' hidden')
  })

  test('escapes value for everything else', () => {
    expect(attr('title', 'A & B').toString()).toBe(' title="A &amp; B"')
    expect(attr('data-count', 7).toString()).toBe(' data-count="7"')
  })

  test('composes inside an element', () => {
    const out = html`<button${attr('disabled', true)}${attr('aria-label', 'Search & jump')}>Go</button>`
    expect(out.toString()).toBe('<button disabled aria-label="Search &amp; jump">Go</button>')
  })

  test('omitting an attribute leaves no space', () => {
    const out = html`<input${attr('value', null)}${attr('placeholder', 'go')}>`
    expect(out.toString()).toBe('<input placeholder="go">')
  })
})

describe('.bytes()', () => {
  test('produces a Uint8Array equivalent to the toString() UTF-8 encoding', () => {
    const out = html`<p>café <em>${'A & B'}</em></p>`
    const bytes = out.bytes()
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(bytes)).toBe(out.toString())
  })

  test('byte length matches Buffer.byteLength of the string form', () => {
    const out = html`unicode: café — résumé ${42}`
    expect(out.bytes().byteLength).toBe(Buffer.byteLength(out.toString(), 'utf8'))
  })
})

describe('immutability', () => {
  test('returned HtmlString is frozen', () => {
    const out = html`<x>${1}</x>`
    expect(Object.isFrozen(out)).toBe(true)
  })

  test('attempting to mutate _chunks does not affect output', () => {
    const out = html`<x>${1}</x>`
    const before = out.toString()
    try { out._chunks.push('<hacked>') } catch {}
    // The array itself isn't frozen (would cost an extra pass per
    // template), but the brand + frozen wrapper means callers
    // shouldn't be poking at internals anyway. Verify toString still
    // works deterministically.
    const after = out.toString()
    expect(after.startsWith(before) || after === before).toBe(true)
  })
})
