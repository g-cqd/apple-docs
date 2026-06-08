import { describe, expect, test } from 'bun:test'
import {
  sfSymbolsSharedInterface,
  symbolCodepointWorkerScript,
} from '../../../src/resources/swift/symbol-codepoint-worker.js'

// The SF Symbols private SymbolFontReader ABI changed at major 8 (a 5th
// MetadataReadingOptions param + an @escaping decryptor closure). The worker
// must mangle to exactly what the provisioned app exports, so the interface +
// init call are chosen by major version. These assert both shapes + that the
// downgrade can't silently no-op if the v8 template is edited.

describe('SF Symbols codepoint worker — version adaptation', () => {
  test('major >= 8 keeps the 5-param @escaping MetadataReadingOptions init', () => {
    const v8 = sfSymbolsSharedInterface(8)
    expect(v8).toContain('enhancedKeywordsURL: Foundation.URL?')
    expect(v8).toContain('fontTableDecryptor: @escaping (CoreText.CTFont, Swift.UInt32) -> Foundation.Data?')
  })

  test('major <= 7 downgrades to the 4-param optional-closure init', () => {
    const v7 = sfSymbolsSharedInterface(7)
    expect(v7).not.toContain('enhancedKeywordsURL')
    expect(v7).toContain('fontTableDecryptor: ((CoreText.CTFont, Swift.UInt32) -> Foundation.Data?)?')
  })

  test('worker script passes enhancedKeywordsURL only for major >= 8', () => {
    expect(symbolCodepointWorkerScript(8)).toContain('enhancedKeywordsURL: nil')
    expect(symbolCodepointWorkerScript(7)).not.toContain('enhancedKeywordsURL')
  })

  test('downgrade path runs without tripping the drift guard', () => {
    // Throws if the v8 markers ever stop matching the baseline templates.
    expect(() => sfSymbolsSharedInterface(7)).not.toThrow()
    expect(() => symbolCodepointWorkerScript(7)).not.toThrow()
  })
})
