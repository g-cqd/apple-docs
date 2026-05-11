/**
 * Long-lived SF Symbol -> Unicode codepoint dump worker.
 *
 * IPC protocol (line-oriented JSON for simplicity — one symbol per
 * line, one JSON line back, easy to parse with Bun's stream reader):
 *
 *   stdin  : "<symbolName>\n"          (UTF-8, no tabs needed)
 *   stdout : '{"name":"...","codepoint":1049270}\n'
 *            '{"name":"...","codepoint":null,"reason":"not in font"}\n'
 *
 * The first CLI argument is the absolute path to a font that carries
 * the SF Symbols glyphs (typically SF-Pro.ttf from the snapshot, with
 * /System/Library/Fonts/SFNS.ttf as a system fallback).
 *
 * Resolution algorithm:
 *   1. NSImage(systemSymbolName:accessibilityDescription:) — confirms
 *      the symbol exists in the runtime catalog.
 *   2. CTFontCreateWithFontDescriptor on the supplied font, then
 *      CTFontGetGlyphWithName(font, "house.fill" as CFString) gives
 *      the inner CGGlyph index.
 *   3. Reverse-walk the PUA codepoints (U+E000..U+F8FF,
 *      U+F0000..U+FFFFD, U+100000..U+10FFFD) via
 *      CTFontGetGlyphsForCharacters in surrogate-pair-aware chunks;
 *      the codepoint whose glyph matches step 2 wins. We cache the
 *      glyph->codepoint table once at startup so per-symbol resolution
 *      is O(1) after the up-front O(PUA) sweep.
 *
 * Edge: NSImage check passes but CTFontGetGlyphWithName returns 0 ->
 * emit {"codepoint":null}. The catalog row stays in the DB with
 * codepoint = NULL; the route layer omits the field.
 *
 * Watch the `\\t` gotcha from commit 75b507a — JS template literals
 * eat one level of backslashes. None of the Swift in this file needs
 * a literal tab, but if a future edit adds one it must be written as
 * `"\\\\t"` here so Swift sees `"\\t"`.
 */

export const SYMBOL_CODEPOINT_WORKER_SCRIPT = `
import AppKit
import CoreText
import Foundation

guard CommandLine.arguments.count >= 2 else {
  FileHandle.standardError.write(Data("usage: symbol-codepoint-worker <fontPath>\\n".utf8))
  exit(2)
}
let fontPath = CommandLine.arguments[1]

func makeFont(path: String, size: CGFloat) -> CTFont? {
  let url = URL(fileURLWithPath: path) as CFURL
  guard let descs = CTFontManagerCreateFontDescriptorsFromURL(url) as? [CTFontDescriptor],
        let first = descs.first else { return nil }
  return CTFontCreateWithFontDescriptor(first, size, nil)
}

guard let font = makeFont(path: fontPath, size: 256) else {
  FileHandle.standardError.write(Data("could not load font at \\(fontPath)\\n".utf8))
  exit(3)
}

// Precompute glyph -> codepoint over the supplementary + BMP PUA.
// CTFontGetGlyphsForCharacters takes UTF-16 code units, so anything
// above U+FFFF must be encoded as a surrogate pair (the function
// consumes two UniChar slots and writes one CGGlyph per codepoint).
//
// Total PUA size: 6,400 (BMP) + 65,534 (SPUA-A) + 65,534 (SPUA-B)
// = 137,468 codepoints. One sweep at startup, ~100ms on this hardware.
let puaRanges: [(UInt32, UInt32)] = [
  (0xE000,   0xF8FF),
  (0xF0000,  0xFFFFD),
  (0x100000, 0x10FFFD),
]

var glyphToCodepoint: [CGGlyph: UInt32] = [:]
glyphToCodepoint.reserveCapacity(40_000)

for (lo, hi) in puaRanges {
  // Process in chunks to keep peak RAM bounded.
  let chunkSize: UInt32 = 4096
  var cp = lo
  while cp <= hi {
    let end = min(cp + chunkSize - 1, hi)
    let count = Int(end - cp + 1)
    var chars: [UniChar] = []
    chars.reserveCapacity(count * 2)
    var codepoints: [UInt32] = []
    codepoints.reserveCapacity(count)
    for c in cp...end {
      if c <= 0xFFFF {
        chars.append(UniChar(c))
        codepoints.append(c)
      } else {
        let adjusted = c - 0x10000
        let high = UniChar(0xD800 + (adjusted >> 10))
        let low  = UniChar(0xDC00 + (adjusted & 0x3FF))
        chars.append(high)
        chars.append(low)
        codepoints.append(c)
      }
    }
    var glyphs = [CGGlyph](repeating: 0, count: codepoints.count)
    // CoreText writes one glyph per codepoint when given a paired UTF-16
    // sequence; supply the input length but read back codepoints.count
    // entries.
    chars.withUnsafeBufferPointer { charsPtr in
      glyphs.withUnsafeMutableBufferPointer { glyphsPtr in
        // Note: the API signature wants the number of UniChars; for the
        // surrogate-paired case it returns one glyph per surrogate-pair,
        // packed at the start of the output buffer.
        _ = CTFontGetGlyphsForCharacters(font, charsPtr.baseAddress!, glyphsPtr.baseAddress!, chars.count)
      }
    }
    // The output is packed: one glyph per logical codepoint. For BMP
    // codepoints that's 1:1; for SPUA, glyph[i] aligns with codepoints[i].
    for i in 0..<codepoints.count {
      let g = glyphs[i]
      if g == 0 { continue }
      // First-write-wins keeps the lowest codepoint when a glyph happens
      // to be mapped from multiple PUA slots (rare for SF Symbols).
      if glyphToCodepoint[g] == nil {
        glyphToCodepoint[g] = codepoints[i]
      }
    }
    cp = end + 1
  }
}

let stdout = FileHandle.standardOutput

// Hand-format the JSON line. Swift's JSONEncoder elides nil optionals
// rather than emitting "key":null, which would force the JS reader to
// guess between "miss" and "field absent". Two-field hand-formatted
// output keeps the contract explicit and the body small.
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

while let raw = readLine(strippingNewline: true) {
  let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  if name.isEmpty { continue }
  // 1. Validate the symbol exists in the runtime catalog. We don't
  //    require this — some private symbols don't construct as
  //    NSImage(systemSymbolName:) but still draw via the framework —
  //    but it's a useful signal in logs. We continue regardless.
  _ = NSImage(systemSymbolName: name, accessibilityDescription: nil)

  // 2. Inner-glyph lookup by PostScript name.
  let glyph = CTFontGetGlyphWithName(font, name as CFString)
  if glyph == 0 {
    writeLine(name: name, codepoint: nil)
    continue
  }

  // 3. Reverse table lookup; null when the inner glyph isn't reachable
  //    via any PUA cmap entry (catalog-shaped names commonly fall here
  //    — they are reached at runtime via GSUB substitutions, not cmap).
  if let cp = glyphToCodepoint[glyph] {
    writeLine(name: name, codepoint: cp)
  } else {
    writeLine(name: name, codepoint: nil)
  }
}
`
