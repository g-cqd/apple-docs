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
 *      `reader.symbol(forSystemName: name, preferComposite: true)`
 *      and emit `FontSymbol.pua.value` as the codepoint.
 *
 * Why this exists: the catalog name→codepoint table is not in any
 * public Apple API. The encrypted font tables are the only on-disk
 * source. Reaching them requires two private frameworks bundled with
 * `SF Symbols.app` (SFSymbolsShared + CoreGlyphsLib) plus a handcrafted
 * `.swiftinterface` per framework (neither ships a `.swiftmodule`).
 * Setup of the module dirs happens in `codepoint-dump.js`; this script
 * just consumes them.
 *
 * Coverage on macOS 26.4 + SF Symbols.app 7.x:
 *   8,302 / 8,302 public catalog names = 100%
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
  metadataDirectory: URL(fileURLWithPath: metadataDir)
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
  if let sym = reader.symbol(forSystemName: name, preferComposite: true) {
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
// SFSymbolsShared and CoreGlyphsLib in SF Symbols.app 7.x. The mangled
// symbols this resolves to are stable across SF Symbols releases since
// 2021 (the same Crypton.decryptObfuscatedFontTable signature shipped
// in SF Symbols 3 onward).
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
      fontTableDecryptor: ((CoreText.CTFont, Swift.UInt32) -> Foundation.Data?)?,
      customCSVData: Foundation.Data?,
      additionalCSVColumns: [Swift.String]?,
      metadataDirectory: Foundation.URL?
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
