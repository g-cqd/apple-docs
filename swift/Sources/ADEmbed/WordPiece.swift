// WordPieceTokenizer.encode mirror (greedy longest-match-first):
//   - words longer than max_input_chars_per_word CODE POINTS → [UNK]
//     (JS counts [...token].length; unicodeScalars.count matches)
//   - continuation pieces are keyed with the "##" prefix
//   - if any position fails to match, the WHOLE word becomes [UNK]

enum WordPiece {
  static func encode(
    word: ArraySlice<Unicode.Scalar>,
    vocab: Vocab,
    unkId: Int32,
    continuationPrefix: [UInt8],
    maxInputCharsPerWord: Int,
    into out: inout [Int32]
  ) {
    if word.count > maxInputCharsPerWord {
      out.append(unkId)
      return
    }
    let scalars = Array(word)
    var subTokens: [Int32] = []
    var start = 0
    while start < scalars.count {
      var end = scalars.count
      var match: Int32?
      while start < end {
        var key = start > 0 ? continuationPrefix : []
        for s in scalars[start..<end] { appendUTF8(s, to: &key) }
        if let id = vocab.id(of: key) {
          match = id
          break
        }
        end -= 1
      }
      guard let id = match else {
        out.append(unkId)
        return
      }
      subTokens.append(id)
      start = end
    }
    out.append(contentsOf: subTokens)
  }

  static func appendUTF8(_ scalar: Unicode.Scalar, to bytes: inout [UInt8]) {
    UTF8.encode(scalar) { bytes.append($0) }
  }
}
