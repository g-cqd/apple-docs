/**
 * Byte-parity gates for the content renderers (RFC 0004 phases 1-2).
 *
 * The committed goldens (test/fixtures/content-parity/fixtures.json,
 * generated from the JS implementation by scripts/gen-content-fixtures.mjs)
 * pin BOTH implementations:
 *   - JS leg (always on): the normative implementation still reproduces
 *     every golden — alarms on unintended JS changes;
 *   - native leg (skipped without the dylib): the Swift port reproduces
 *     every golden byte-exactly through the production entry points.
 */

import { suffix } from 'bun:ffi'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderPage } from '../../../src/apple/renderer.js'
import { _forceImpl } from '../../../src/content/content-native.js'
import { renderMarkdown } from '../../../src/content/render-markdown.js'
import { renderPlainText } from '../../../src/content/render-text.js'
import { _resetNativeLoader } from '../../../src/native/loader.js'

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'content-parity', 'fixtures.json')
const DEV_LIB = new URL(`../../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
const nativeAvailable = !!process.env.APPLE_DOCS_NATIVE_LIB || existsSync(DEV_LIB)

const { meta, docCases, pageCases } = JSON.parse(readFileSync(FIXTURES, 'utf8'))

function checkAll(label) {
  const mismatches = []
  for (const c of docCases) {
    if (renderMarkdown(c.document, c.sections) !== c.markdown) mismatches.push(`${c.name} md`)
    if (renderMarkdown(c.document, c.sections, { includeFrontMatter: false, includeTitle: false }) !== c.markdownBare) {
      mismatches.push(`${c.name} md-bare`)
    }
    if (renderPlainText(c.plainDocument, c.sections) !== c.plaintext) {
      mismatches.push(`${c.name} text`)
    }
  }
  for (const c of pageCases) {
    if (renderPage(JSON.parse(c.rawJson), c.path) !== c.markdown) mismatches.push(`${c.name} page`)
  }
  expect({ impl: label, mismatches }).toEqual({ impl: label, mismatches: [] })
}

describe('content goldens', () => {
  test('fixture corpus covers every source type', () => {
    expect(meta.docCaseCount).toBe(docCases.length)
    expect(meta.pageCaseCount).toBe(pageCases.length)
    expect(docCases.length).toBeGreaterThanOrEqual(meta.sourceTypes.length)
    const covered = new Set(docCases.map((c) => c.name.split(':')[0]))
    for (const sourceType of meta.sourceTypes) expect(covered.has(sourceType)).toBe(true)
  })

  test('js implementation reproduces every golden', () => {
    _forceImpl('js')
    try {
      checkAll('js')
    } finally {
      _forceImpl(null)
    }
  })

  describe.skipIf(!nativeAvailable)('native', () => {
    beforeAll(() => {
      process.env.APPLE_DOCS_NATIVE_LIB ??= DEV_LIB
      _resetNativeLoader()
      _forceImpl('native')
    })
    afterAll(() => {
      _forceImpl(null)
      if (process.env.APPLE_DOCS_NATIVE_LIB === DEV_LIB) delete process.env.APPLE_DOCS_NATIVE_LIB
      _resetNativeLoader()
    })

    test('native implementation reproduces every golden byte-exactly', () => {
      checkAll('native')
    })
  })
})
