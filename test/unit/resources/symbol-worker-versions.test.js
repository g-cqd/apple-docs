import { describe, expect, test } from 'bun:test'
import {
  LATEST_KNOWN_SF_SYMBOLS_MAJOR,
  sfSymbolsSharedInterface,
  symbolCodepointWorkerScript,
} from '../../../src/resources/swift/symbol-codepoint-worker.js'

// The SF Symbols private SymbolFontReader ABI drifts across majors:
//   8  — a 5th MetadataReadingOptions param + an @escaping decryptor closure.
//   27 — VariableSymbolFontProvider.init grew `supportsScales:` and
//        FontSymbol lost its `pua` accessor (the PUA scalar is read via
//        `metadata?.privateScalar` instead).
// The worker must mangle to exactly what the provisioned app exports, so the
// interface + Swift source are chosen by major version. These assert every
// shape + that a swap can't silently no-op if a baseline template is edited.

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

  test('8..26 declare the single-label provider init and read FontSymbol.pua', () => {
    for (const major of [8, 9, 26]) {
      const iface = sfSymbolsSharedInterface(major)
      expect(iface).toContain('public init(url: Foundation.URL)\n')
      expect(iface).not.toContain('supportsScales')
      expect(iface).toContain('public var pua: Swift.Unicode.Scalar { get }')
      const script = symbolCodepointWorkerScript(major)
      expect(script).toContain('VariableSymbolFontProvider(url: fontURL)\n')
      expect(script).toContain('codepoint: sym.pua.value')
      expect(script).not.toContain('privateScalar')
    }
  })

  test('major >= 27 declares init(url:supportsScales:) and drops the pua accessor', () => {
    for (const major of [27, 28, LATEST_KNOWN_SF_SYMBOLS_MAJOR]) {
      const iface = sfSymbolsSharedInterface(major)
      expect(iface).toContain('public init(url: Foundation.URL, supportsScales: Swift.Bool)')
      expect(iface).not.toContain('public init(url: Foundation.URL)\n')
      expect(iface).not.toContain('var pua:')
      // Still declared: the replacement read path goes through metadata.
      expect(iface).toContain('public var privateScalar: Swift.Unicode.Scalar? { get }')
      expect(iface).toContain('public var metadata: SFSymbolsShared.SymbolMetadata? { get }')
      // The 5-param init is the v8 baseline and unchanged in 27.
      expect(iface).toContain('enhancedKeywordsURL: Foundation.URL?')

      const script = symbolCodepointWorkerScript(major)
      expect(script).toContain('VariableSymbolFontProvider(url: fontURL, supportsScales: true)')
      expect(script).toContain('codepoint: sym.metadata?.privateScalar?.value')
      expect(script).not.toContain('sym.pua')
      expect(script).toContain('enhancedKeywordsURL: nil')
    }
  })

  test('every major asks for the monolithic (non-composite) scalar', () => {
    // Slash/badge symbols carry a composite AND a monolithic PUA scalar in
    // SFSymbolsFallback.otf; only the monolithic one has a glyph in SF Pro /
    // SF Compact (where the codepoint is consumed), and SF Symbols 27 exposes
    // only that one — so `preferComposite` must be false on every path or the
    // app versions disagree on ~1,800 symbols.
    for (const major of [7, 8, 27]) {
      const script = symbolCodepointWorkerScript(major)
      expect(script).toContain('preferComposite: false')
      expect(script).not.toContain('preferComposite: true')
    }
  })

  test('latest known major is the top of the adaptation ladder', () => {
    expect(LATEST_KNOWN_SF_SYMBOLS_MAJOR).toBe(27)
    expect(sfSymbolsSharedInterface(LATEST_KNOWN_SF_SYMBOLS_MAJOR))
      .toBe(sfSymbolsSharedInterface(27))
  })

  test('swap paths run without tripping the drift guard', () => {
    // Throws if the v8 baseline markers ever stop matching the templates.
    for (const major of [7, 8, 27]) {
      expect(() => sfSymbolsSharedInterface(major)).not.toThrow()
      expect(() => symbolCodepointWorkerScript(major)).not.toThrow()
    }
  })
})
