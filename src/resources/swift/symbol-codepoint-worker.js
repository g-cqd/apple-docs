/**
 * Long-lived SF Symbol -> Unicode codepoint dump worker.
 *
 * IPC protocol (line-oriented JSON for simplicity — one symbol per
 * line, one JSON line back, easy to parse with Bun's stream reader):
 *
 *   stdin  : "<symbolName>\n"          (UTF-8, no tabs needed)
 *   stdout : '{"name":"...","codepoint":1049247}\n'
 *            '{"name":"...","codepoint":null,"reason":"not in font"}\n'
 *
 * CLI arguments (positional):
 *   1: absolute path to SFSymbolsFallback.otf
 *   2: absolute path to SymbolMetadata directory
 *      (SFSymbols.framework/Resources/metadata)
 *
 * Resolution algorithm:
 *   1. Build a `SymbolFontReader` from `SFSymbolsFallback.otf` with
 *      `Crypton.decryptObfuscatedFontTable` (CoreGlyphsLib.framework)
 *      supplied as the `fontTableDecryptor`. This unlocks the
 *      encrypted `syls` (77 MB) + `symp` (753 KB) tables that hold the
 *      catalog name→PUA-codepoint mapping.
 *   2. For each symbol name on stdin, call
 *      `reader.symbol(forSystemName: name, preferComposite: false)`
 *      and emit the PUA scalar as the codepoint (`FontSymbol.pua.value`
 *      through SF Symbols 8; `FontSymbol.metadata?.privateScalar?.value`
 *      from SF Symbols 27, which dropped the `pua` accessor).
 *
 *      `preferComposite` MUST be false. Slash/badge symbols carry two PUA
 *      scalars in SFSymbolsFallback.otf — a "composite" glyph assembled
 *      from parts and a monolithic one — and only the monolithic scalar
 *      exists in the SF Pro / SF Compact fonts the codepoint is consumed
 *      with (web symbols page, font subsets). `preferComposite: true`
 *      (the behaviour through 2026-09) stamped the composite scalar for
 *      ~1,800 symbols, which renders as a missing glyph in SF Pro. SF
 *      Symbols 27 exposes only the monolithic scalar anyway, so `false`
 *      also makes every app version agree byte-for-byte.
 *
 * Why this exists: the catalog name→codepoint table is not in any
 * public Apple API. The encrypted font tables are the only on-disk
 * source. Reaching them requires two private frameworks bundled with
 * `SF Symbols.app` (SFSymbolsShared + CoreGlyphsLib) plus a handcrafted
 * `.swiftinterface` per framework (neither ships a `.swiftmodule`).
 * Setup of the module dirs happens in `codepoint-dump.js`; this script
 * just consumes them.
 *
 * Coverage on macOS 26.4 + SF Symbols.app 8.0:
 *   8,302 / 8,302 public catalog names = 100%
 *
 * The templates below are the SF Symbols 8 baseline; the version-adaptive
 * section at the bottom swaps the ABI-bearing lines for other majors (≤ 7 and
 * ≥ 27). A `.swiftinterface` must mangle byte-for-byte to what the provisioned
 * framework exports or the script JIT-fails to link (symbol not found), so a
 * future major that changes these signatures needs the same treatment
 * (dump with `nm -gU … | xcrun swift-demangle`, then mirror here).
 *
 * Watch the `\\t` gotcha from commit 75b507a — JS template literals
 * eat one level of backslashes. None of the Swift in this file needs
 * a literal tab, but if a future edit adds one it must be written as
 * `"\\\\t"` here so Swift sees `"\\t"`.
 */

export const SYMBOL_CODEPOINT_WORKER_SCRIPT = `
import Foundation
import CoreText
import SFSymbolsShared
import CoreGlyphsLib

guard CommandLine.arguments.count >= 3 else {
  FileHandle.standardError.write(Data("usage: symbol-codepoint-worker <fontPath> <metadataDir>\\n".utf8))
  exit(2)
}
let fontPath = CommandLine.arguments[1]
let metadataDir = CommandLine.arguments[2]

let fontURL = URL(fileURLWithPath: fontPath)
guard FileManager.default.fileExists(atPath: fontPath) else {
  FileHandle.standardError.write(Data("font not found at \\(fontPath)\\n".utf8))
  exit(3)
}

let provider = VariableSymbolFontProvider(url: fontURL)
let opts = SymbolFontReader.MetadataReadingOptions(
  fontTableDecryptor: { font, tag in
    Crypton.decryptObfuscatedFontTable(tableTag: tag, from: font)
  },
  customCSVData: nil,
  additionalCSVColumns: nil,
  metadataDirectory: URL(fileURLWithPath: metadataDir),
  enhancedKeywordsURL: nil
)

let reader: SymbolFontReader
do {
  reader = try SymbolFontReader(symbolFontProvider: provider, metadataReadingOptions: opts)
} catch {
  FileHandle.standardError.write(Data("reader init failed: \\(error)\\n".utf8))
  exit(4)
}

let stdout = FileHandle.standardOutput

func escapeJsonString(_ s: String) -> String {
  var out = ""
  out.reserveCapacity(s.count)
  for scalar in s.unicodeScalars {
    switch scalar {
    case "\\\\": out += "\\\\\\\\"
    case "\\"": out += "\\\\\\""
    case "\\n": out += "\\\\n"
    case "\\r": out += "\\\\r"
    case "\\t": out += "\\\\t"
    default:
      if scalar.value < 0x20 {
        out += String(format: "\\\\u%04x", scalar.value)
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  return out
}

func writeLine(name: String, codepoint: UInt32?) {
  let escapedName = escapeJsonString(name)
  let cpPart: String
  if let cp = codepoint {
    cpPart = String(cp)
  } else {
    cpPart = "null"
  }
  let line = "{\\"name\\":\\"\\(escapedName)\\",\\"codepoint\\":\\(cpPart)}\\n"
  stdout.write(Data(line.utf8))
}

while let raw = readLine(strippingNewline: true) {
  let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  if name.isEmpty { continue }
  if let sym = reader.symbol(forSystemName: name, preferComposite: false) {
    writeLine(name: name, codepoint: sym.pua.value)
  } else {
    writeLine(name: name, codepoint: nil)
  }
}
`

// The two handcrafted .swiftinterface files the worker imports. They
// declare just the public surface we touch; the layout is opaque under
// library-evolution mode so the actual struct/class internals can change
// across SF Symbols.app versions without breaking us.
//
// Reverse-engineered from `nm -gU` + `xcrun swift-demangle` against
// SFSymbolsShared and CoreGlyphsLib in SF Symbols.app 8.0. Crypton's
// decryptObfuscatedFontTable + VariableSymbolFontProvider.init + symbol(
// forSystemName:) have been stable since SF Symbols 3; only
// MetadataReadingOptions.init drifts — 8.0 grew the `enhancedKeywordsURL`
// parameter, so the declared init must mangle byte-for-byte to the v8 symbol
// (5 labels, an @escaping decryptor closure → `…Vtc_…`, not `…VtXE_…`).
export const SF_SYMBOLS_SHARED_INTERFACE = `// swift-interface-format-version: 1.0
// swift-compiler-version: Apple Swift version 5.10
// swift-module-flags: -target arm64-apple-macos14.0 -enable-library-evolution -module-name SFSymbolsShared
import CoreText
import Foundation
import Swift

public protocol SymbolFontProvider {}

public struct VariableSymbolFontProvider : SFSymbolsShared.SymbolFontProvider {
  public init(url: Foundation.URL)
}

public struct SymbolMetadata {
  public var name: Swift.String { get }
  public var privateScalar: Swift.Unicode.Scalar? { get }
  public var publicScalars: [Swift.Unicode.Scalar] { get }
}

public struct FontSymbol {
  public var pua: Swift.Unicode.Scalar { get }
  public var metadata: SFSymbolsShared.SymbolMetadata? { get }
}

final public class SymbolFontReader {
  public struct MetadataReadingOptions {
    public init(
      fontTableDecryptor: @escaping (CoreText.CTFont, Swift.UInt32) -> Foundation.Data?,
      customCSVData: Foundation.Data?,
      additionalCSVColumns: [Swift.String]?,
      metadataDirectory: Foundation.URL?,
      enhancedKeywordsURL: Foundation.URL?
    )
  }
  public init<A>(symbolFontProvider: A, metadataReadingOptions: SFSymbolsShared.SymbolFontReader.MetadataReadingOptions) throws where A : SFSymbolsShared.SymbolFontProvider
  final public func symbol(forSystemName: Swift.String, preferComposite: Swift.Bool) -> SFSymbolsShared.FontSymbol?
}
`

export const CORE_GLYPHS_LIB_INTERFACE = `// swift-interface-format-version: 1.0
// swift-compiler-version: Apple Swift version 5.10
// swift-module-flags: -target arm64-apple-macos14.0 -enable-library-evolution -module-name CoreGlyphsLib
import CoreText
import Foundation
import Swift

public struct Crypton {
  public static func decryptObfuscatedFontTable(tableTag: Swift.UInt32, from: CoreText.CTFont) -> Foundation.Data?
}
`

// ── Version-adaptive selection ──────────────────────────────────────────────
//
// The two exports above are the SF Symbols 8 baseline (8.x was the last
// app-numbered release; the next major jumped to 27 to track the OS version).
// The worker must mangle to exactly what the provisioned app exports, so the
// interface + the Swift source are selected by the app's major version —
// codepoint-dump.js reads it from the bundle's CFBundleShortVersionString —
// by swapping the ABI-bearing lines of the baseline. The drift guard throws
// loudly if a future edit renames a baseline marker so a swap can't silently
// no-op.
//
//   ≤ 7    4-parameter MetadataReadingOptions.init, OPTIONAL decryptor closure,
//          no `enhancedKeywordsURL`.
//   8..26  baseline — 5-parameter init with an @escaping decryptor.
//   ≥ 27   `VariableSymbolFontProvider.init(url:supportsScales:)` gained a
//          second label and `FontSymbol.pua` was removed; the PUA scalar is
//          read through `FontSymbol.metadata?.privateScalar` instead (same
//          value — cross-checked against the 8.2 `pua` dump, see
//          test/unit/resources/symbol-worker-versions.test.js).

/** Newest SF Symbols.app major the templates are known to link against. */
export const LATEST_KNOWN_SF_SYMBOLS_MAJOR = 27

const V8_META_INIT = `    public init(
      fontTableDecryptor: @escaping (CoreText.CTFont, Swift.UInt32) -> Foundation.Data?,
      customCSVData: Foundation.Data?,
      additionalCSVColumns: [Swift.String]?,
      metadataDirectory: Foundation.URL?,
      enhancedKeywordsURL: Foundation.URL?
    )`

const V7_META_INIT = `    public init(
      fontTableDecryptor: ((CoreText.CTFont, Swift.UInt32) -> Foundation.Data?)?,
      customCSVData: Foundation.Data?,
      additionalCSVColumns: [Swift.String]?,
      metadataDirectory: Foundation.URL?
    )`

const V8_ENHANCED_ARG = ',\n  enhancedKeywordsURL: nil'

// ≥ 27 interface swaps.
const V8_PROVIDER_INIT = '  public init(url: Foundation.URL)'
const V27_PROVIDER_INIT = '  public init(url: Foundation.URL, supportsScales: Swift.Bool)'
const V8_PUA_GETTER = '  public var pua: Swift.Unicode.Scalar { get }\n'

// ≥ 27 script swaps.
const V8_PROVIDER_CALL = 'VariableSymbolFontProvider(url: fontURL)'
const V27_PROVIDER_CALL = 'VariableSymbolFontProvider(url: fontURL, supportsScales: true)'
const V8_PUA_READ = 'codepoint: sym.pua.value'
const V27_PUA_READ = 'codepoint: sym.metadata?.privateScalar?.value'

function swap(text, marker, replacement) {
  if (!text.includes(marker)) {
    throw new Error('symbol-codepoint-worker: version template drifted (v8 baseline marker not found)')
  }
  return text.split(marker).join(replacement)
}

/** SFSymbolsShared `.swiftinterface` matched to the app's major version. */
export function sfSymbolsSharedInterface(major) {
  if (major >= 27) {
    return swap(
      swap(SF_SYMBOLS_SHARED_INTERFACE, V8_PROVIDER_INIT, V27_PROVIDER_INIT),
      V8_PUA_GETTER, '',
    )
  }
  if (major >= 8) return SF_SYMBOLS_SHARED_INTERFACE
  return swap(SF_SYMBOLS_SHARED_INTERFACE, V8_META_INIT, V7_META_INIT)
}

/** Worker Swift source matched to the app's major version. */
export function symbolCodepointWorkerScript(major) {
  if (major >= 27) {
    return swap(
      swap(SYMBOL_CODEPOINT_WORKER_SCRIPT, V8_PROVIDER_CALL, V27_PROVIDER_CALL),
      V8_PUA_READ, V27_PUA_READ,
    )
  }
  if (major >= 8) return SYMBOL_CODEPOINT_WORKER_SCRIPT
  return swap(SYMBOL_CODEPOINT_WORKER_SCRIPT, V8_ENHANCED_ARG, '')
}
