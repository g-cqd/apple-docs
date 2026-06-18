// WordPieceTokenizer.encode mirror (greedy longest-match-first):
//   - words longer than max_input_chars_per_word CODE POINTS → [UNK]
//     (JS counts [...token].length; unicodeScalars.count matches)
//   - continuation pieces are keyed with the "##" prefix
//   - if any position fails to match, the WHOLE word becomes [UNK]
//
// The word's UTF-8 is built once with per-scalar byte offsets; every greedy
// candidate is then a (prefix, slice) probe into the vocab's flat table —
// no per-candidate allocation (the naive rebuild-the-key version allocated
// a key array per candidate and dominated the embed profile).
//
// The `wordBytes`/`offsets` scratch buffers are owned by the caller
// (`Tokenizer.encode`) and reused across every pre-token word, cleared with
// `removeAll(keepingCapacity: true)` per word — the previous per-word
// `[UInt8]`/`[Int]` allocations (per word × section × text) are gone. The
// buffers never escape this call (no storing, no `Sendable` crossing), and the
// produced token ids are byte-for-byte identical: only the storage lifetime
// changed, not the bytes/offsets computed into it.

enum WordPiece {
    static func encode(
        word: ArraySlice<Unicode.Scalar>,
        vocab: Vocab,
        unkId: Int32,
        continuationPrefix: [UInt8],
        maxInputCharsPerWord: Int,
        wordBytes: inout [UInt8],
        offsets: inout [Int],
        into out: inout [Int32]
    ) {
        let n = word.count
        if n > maxInputCharsPerWord {
            out.append(unkId)
            return
        }
        wordBytes.removeAll(keepingCapacity: true)
        wordBytes.reserveCapacity(n * 2)
        offsets.removeAll(keepingCapacity: true)
        offsets.reserveCapacity(n + 1)
        offsets.append(0)
        for s in word {
            appendUTF8(s, to: &wordBytes)
            offsets.append(wordBytes.count)
        }

        let subTokens: [Int32]? = wordBytes.withUnsafeBufferPointer { bytes in
            continuationPrefix.withUnsafeBufferPointer { prefixBuffer in
                let emptyPrefix = UnsafeBufferPointer<UInt8>(start: nil, count: 0)
                var sub: [Int32] = []
                var start = 0
                while start < n {
                    var end = n
                    var match: Int32?
                    while start < end {
                        let body = UnsafeBufferPointer(rebasing: bytes[offsets[start] ..< offsets[end]])
                        if let id = vocab.id(prefix: start > 0 ? prefixBuffer : emptyPrefix, body: body) {
                            match = id
                            break
                        }
                        end -= 1
                    }
                    guard let id = match else { return nil }  // whole word → [UNK]
                    sub.append(id)
                    start = end
                }
                return sub
            }
        }
        if let subTokens {
            out.append(contentsOf: subTokens)
        } else {
            out.append(unkId)
        }
    }

    static func appendUTF8(_ scalar: Unicode.Scalar, to bytes: inout [UInt8]) {
        UTF8.encode(scalar) { bytes.append($0) }
    }
}
