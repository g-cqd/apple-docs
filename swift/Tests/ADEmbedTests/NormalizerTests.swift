// Stage-level checks for the captured transformers.js v4.2.0 semantics —
// each test pins one of the documented parity traps so a parity failure
// localizes to a stage instead of a 180-case diff.

import Testing

@testable import ADEmbed

private func scalars(_ s: String) -> [Unicode.Scalar] {
  Array(s.unicodeScalars)
}

private func text(_ s: [Unicode.Scalar]) -> String {
  var out = ""
  out.unicodeScalars.append(contentsOf: s)
  return out
}

struct NormalizerTests {
  @Test func cleanTextRemovesControlsOutright() {
    // VT/FF/FEFF/ZWSP/SHY/ZWJ vanish (no space); \t survives as ' '.
    let input = scalars("a\u{B}b\u{C}c\u{FEFF}d\u{200B}e\u{AD}f\u{200D}g")
    #expect(text(Normalizer.normalize(input)) == "abcdefg")
    #expect(text(Normalizer.normalize(scalars("a\tb"))) == "a b")
    #expect(text(Normalizer.normalize(scalars("a\u{0}b\u{FFFD}c"))) == "abc")
  }

  @Test func whitespaceVarietiesBecomeAsciiSpace() {
    let input = scalars("a\u{A0}b\u{2003}c\u{3000}d\u{2028}e")
    #expect(text(Normalizer.normalize(input)) == "a b c d e")
  }

  @Test func chineseSpacingIsBmpOnly() {
    #expect(text(Normalizer.normalize(scalars("x中y"))) == "x 中 y")
    // Astral CJK is untouched: transformers.js iterates UTF-16 units.
    #expect(text(Normalizer.normalize(scalars("x\u{20000}y"))) == "x\u{20000}y")
    // Kana and Hangul are outside the ranges.
    #expect(text(Normalizer.normalize(scalars("xあy"))) == "xあy")
  }

  @Test func lowercaseRunsBeforeStripAccents() {
    // İ → i + U+0307 (full mapping), then the dot above strips as Mn.
    #expect(text(Normalizer.normalize(scalars("İ"))) == "i")
    #expect(text(Normalizer.normalize(scalars("Café"))) == "cafe")
    // U+212B angstrom decomposes to a + ring; the ring strips.
    #expect(text(Normalizer.normalize(scalars("\u{212B}"))) == "a")
  }

  @Test func variationSelectorIsNonspacingMark() {
    #expect(text(Normalizer.normalize(scalars("a\u{FE0F}b"))) == "ab")
  }
}

struct CaseFoldingTests {
  @Test func finalSigmaContextRule() {
    #expect(text(CaseFolding.lowercase(scalars("ΟΔΟΣ"))) == "οδος")
    #expect(text(CaseFolding.lowercase(scalars("ΣΑΣ"))) == "σας")
    #expect(text(CaseFolding.lowercase(scalars("Σ"))) == "σ")
    // Punctuation after sigma is not cased → still final.
    #expect(text(CaseFolding.lowercase(scalars("ΟΣ."))) == "ος.")
    // A combining mark between sigma and a following letter is
    // case-ignorable → not final.
    #expect(text(CaseFolding.lowercase(scalars("ΑΣ\u{301}Α"))) == "ασ\u{301}α")
  }

  @Test func fullMappings() {
    #expect(CaseFolding.lowercase(scalars("İ")).map(\.value) == [0x69, 0x307])
    #expect(text(CaseFolding.lowercase(scalars("ẞ"))) == "ß")
    #expect(text(CaseFolding.lowercase(scalars("ǄX"))) == "ǆx")
  }
}

struct NFDTests {
  @Test func tableDecomposition() {
    #expect(NFD.decompose([Unicode.Scalar(0xE9)!]).map(\.value) == [0x65, 0x301])
  }

  @Test func hangulIsAlgorithmic() {
    #expect(NFD.decompose([Unicode.Scalar(0xD55C)!]).map(\.value) == [0x1112, 0x1161, 0x11AB])
    // No-trailing-consonant syllable → L V only.
    #expect(NFD.decompose([Unicode.Scalar(0xAC00)!]).map(\.value) == [0x1100, 0x1161])
  }

  @Test func canonicalReorderingIsStableByCombiningClass() {
    // acute (ccc 230) before grave-below (ccc 220) must swap…
    let q = Unicode.Scalar(0x71)!
    let acute = Unicode.Scalar(0x301)!
    let below = Unicode.Scalar(0x316)!
    #expect(NFD.decompose([q, acute, below]).map(\.value) == [0x71, 0x316, 0x301])
    // …and the already-canonical order is untouched.
    #expect(NFD.decompose([q, below, acute]).map(\.value) == [0x71, 0x316, 0x301])
  }
}
