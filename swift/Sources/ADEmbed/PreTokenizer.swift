// BertPreTokenizer mirror: text.trim().match(/[^\s P]+|[P]/gu) where P is
// \p{P} plus the ASCII symbol ranges ! - /, : - @, [ - `, { - ~ (so `_` and
// `$ + < = > ^ | ~` split, while € or ∑ stay word characters). The leading
// trim is subsumed: unmatched whitespace never emits a token.

import ADFUnicode

enum PreTokenizer {
  static func split(_ scalars: [Unicode.Scalar]) -> [ArraySlice<Unicode.Scalar>] {
    var tokens: [ArraySlice<Unicode.Scalar>] = []
    var runStart = -1
    for i in 0..<scalars.count {
      let v = scalars[i].value
      if UnicodeSets.isJsWhitespace(v) {
        if runStart >= 0 {
          tokens.append(scalars[runStart..<i])
          runStart = -1
        }
      } else if UnicodeSets.isBertPunctuation(v) {
        if runStart >= 0 {
          tokens.append(scalars[runStart..<i])
          runStart = -1
        }
        tokens.append(scalars[i..<i + 1])
      } else if runStart < 0 {
        runStart = i
      }
    }
    if runStart >= 0 { tokens.append(scalars[runStart...]) }
    return tokens
  }
}
