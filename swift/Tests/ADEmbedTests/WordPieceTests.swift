// WordPiece, vocab keying, pre-tokenizer classes, and added-token splitting
// against tiny synthetic vocabularies.

import Testing

@testable import ADEmbed

private func scalars(_ s: String) -> [Unicode.Scalar] {
    Array(s.unicodeScalars)
}

private func words(_ s: String) -> [String] {
    PreTokenizer.split(scalars(s))
        .map { slice in
            var out = ""
            out.unicodeScalars.append(contentsOf: slice)
            return out
        }
}

struct PreTokenizerTests {
    @Test func punctuationIsIsolated() {
        #expect(words("a+b=c") == ["a", "+", "b", "=", "c"])
        #expect(words("snake_case") == ["snake", "_", "case"])
        #expect(words("$5") == ["$", "5"])
    }

    @Test func currencyAndMathSymbolsAreWordCharacters() {
        #expect(words("€100") == ["€100"])
        #expect(words("a∑b") == ["a∑b"])
    }

    @Test func whitespaceSeparatesWithoutEmitting() {
        #expect(words("  x  y ") == ["x", "y"])
        #expect(words("   ").isEmpty)
        #expect(words("").isEmpty)
    }
}

struct VocabTests {
    @Test func keysAreExactBytesNotCanonicalEquivalence() {
        // NFD-form key must not be reachable through the NFC spelling — JS Maps
        // key on exact code units; Swift String hashing would conflate these.
        let vocab = Vocab(tokens: ["e\u{301}"])
        #expect(vocab.id(of: Array("e\u{301}".utf8)) == 0)
        #expect(vocab.id(of: Array("\u{E9}".utf8)) == nil)
    }
}

struct WordPieceTests {
    private let vocab = Vocab(tokens: ["[PAD]", "[UNK]", "want", "##ed", "wa", "##nt"])
    private let prefix = Array("##".utf8)

    private func encode(_ word: String, max: Int = 100) -> [Int32] {
        var out: [Int32] = []
        var wordBytes: [UInt8] = []
        var offsets: [Int] = []
        WordPiece.encode(
            word: scalars(word)[...],
            vocab: vocab,
            unkId: 1,
            continuationPrefix: prefix,
            maxInputCharsPerWord: max,
            wordBytes: &wordBytes,
            offsets: &offsets,
            into: &out
        )
        return out
    }

    @Test func greedyLongestMatchFirst() {
        #expect(encode("wanted") == [2, 3])
        #expect(encode("want") == [2])
    }

    @Test func wholeWordUnkOnAnyFailure() {
        // "wax": "wa" matches, then no "##x" → the whole word collapses to UNK.
        #expect(encode("wax") == [1])
    }

    @Test func maxInputCharsCountsCodePoints() {
        #expect(encode(String(repeating: "a", count: 101)) == [1])
        // 101 astral scalars are 202 UTF-16 units but still >100 code points.
        #expect(encode(String(repeating: "\u{1D49C}", count: 101)) == [1])
        // 100 scalars pass the length gate (and then UNK on lookup, not length).
        #expect(encode(String(repeating: "a", count: 100)) == [1])
    }
}

struct AddedTokenSplitTests {
    private let tokenizer = Tokenizer(
        vocab: ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]", "x", "y"],
        addedTokens: [
            .init(content: "[PAD]", id: 0),
            .init(content: "[UNK]", id: 1),
            .init(content: "[CLS]", id: 2),
            .init(content: "[SEP]", id: 3),
            .init(content: "[MASK]", id: 4)
        ]
    )

    @Test func literalsBypassNormalization() {
        #expect(tokenizer.encode("[CLS]") == [2])
        #expect(tokenizer.encode("x[SEP]y") == [5, 3, 6])
        #expect(tokenizer.encode("[MASK][MASK]") == [4, 4])
    }

    @Test func partialAndLowercaseLiteralsTakeTheNormalPath() {
        // "[CLS" → normalizer lowercases → pre-tokens "[", "cls" → both UNK here.
        #expect(tokenizer.encode("[CLS") == [1, 1])
        #expect(tokenizer.encode("[cls]") == [1, 1, 1])
    }

    @Test func emptyInputYieldsRawEmpty() {
        #expect(tokenizer.encode("").isEmpty)
        #expect(tokenizer.encode("   ").isEmpty)
    }
}
