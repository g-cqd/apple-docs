// BertNormalizer mirrored from @huggingface/transformers 4.2.0 (normative),
// fixed to the potion configuration: { clean_text: true,
// handle_chinese_chars: true, strip_accents: null, lowercase: true }.
//
// Parity traps encoded here (each diverges from the HF Rust reference):
//   - Stage order is lowercase THEN strip_accents (strip runs because
//     strip_accents !== false when lowercase is on).
//   - clean_text removes Cc/Cf/Co (and \u{0}/\u{FFFD}) outright — VT, FF,
//     FEFF, ZWSP, SHY, ZWJ never become spaces. Only \t \n \r survive the
//     control check and map to ' ' via the whitespace branch.
//   - tokenize_chinese_chars iterates UTF-16 units in JS, so only BMP
//     scalars can match; the generated chineseChar table is BMP-only.

import ADFUnicode

enum Normalizer {
  private static let space: Unicode.Scalar = " "

  static func normalize(_ text: [Unicode.Scalar]) -> [Unicode.Scalar] {
    var cleaned: [Unicode.Scalar] = []
    cleaned.reserveCapacity(text.count)
    for s in text {
      if UnicodeSets.isCleanTextRemoved(s.value) { continue }
      cleaned.append(UnicodeSets.isJsWhitespace(s.value) ? space : s)
    }

    var spaced: [Unicode.Scalar] = []
    spaced.reserveCapacity(cleaned.count)
    for s in cleaned {
      if UnicodeSets.isChinese(s.value) {
        spaced.append(space)
        spaced.append(s)
        spaced.append(space)
      } else {
        spaced.append(s)
      }
    }

    let lowered = CaseFolding.lowercase(spaced)

    var stripped: [Unicode.Scalar] = []
    stripped.reserveCapacity(lowered.count)
    // Lowest Mn scalar is U+0300 — cheap bail before the range search.
    for s in NFD.decompose(lowered) where s.value < 0x300 || !UnicodeSets.isNonspacingMark(s.value) {
      stripped.append(s)
    }
    return stripped
  }
}
