// transformers.js-parity WordPiece tokenizer.
//
// Mirrors PreTrainedTokenizer.encode from @huggingface/transformers 4.2.0
// for the potion-retrieval-32M configuration and the production call shape
// `tokenizer(texts, { add_special_tokens: false, return_tensor: false })`:
//
//   1. DictionarySplitter over the added-token literals splits the RAW text
//      (leftmost-longest); matched sections emit their id directly. All
//      potion added tokens are normalized:false with lstrip/rstrip:false, so
//      the post-normalization splitter pass is a structural no-op and the
//      sections see no trimming.
//   2. Other sections: BertNormalizer → BertPreTokenizer → WordPiece.
//   3. TemplateProcessing contributes nothing under add_special_tokens:false.
//
// Returns the RAW id sequence — [] for empty/whitespace-only input. The
// production `[0]` ([PAD]) substitution for empty outputs is embedder-level
// and stays with the caller.

public struct Tokenizer: Sendable {
    public struct AddedToken: Sendable {
        public let content: String
        public let id: Int32

        public init(content: String, id: Int32) {
            self.content = content
            self.id = id
        }
    }

    private let vocab: Vocab
    private let added: [(scalars: [Unicode.Scalar], id: Int32)]
    private let unkId: Int32
    private let continuationPrefix: [UInt8]
    private let maxInputCharsPerWord: Int

    /// `vocab` is the id-ordered token array. The unk token must resolve to an
    /// id — guaranteed for any real WordPiece vocab; the FFI boundary validates
    /// before construction.
    public init(
        vocab tokens: [String],
        addedTokens: [AddedToken],
        unkToken: String = "[UNK]",
        continuingSubwordPrefix: String = "##",
        maxInputCharsPerWord: Int = 100
    ) {
        let vocab = Vocab(tokens: tokens)
        let unkId =
            vocab.id(of: Array(unkToken.utf8))
            ?? addedTokens.first(where: { $0.content == unkToken })?.id
        precondition(unkId != nil, "unk token \(unkToken) missing from vocab and added tokens")
        self.vocab = vocab
        self.added = addedTokens.map { (Array($0.content.unicodeScalars), $0.id) }
        self.unkId = unkId!
        self.continuationPrefix = Array(continuingSubwordPrefix.utf8)
        self.maxInputCharsPerWord = maxInputCharsPerWord
    }

    public func encode(_ text: String) -> [Int32] {
        let scalars = Array(text.unicodeScalars)
        var out: [Int32] = []
        for section in splitOnAddedTokens(scalars) {
            switch section {
                case .added(let id):
                    out.append(id)
                case .text(let slice):
                    let normalized = Normalizer.normalize(Array(slice))
                    for word in PreTokenizer.split(normalized) {
                        WordPiece.encode(
                            word: word,
                            vocab: vocab,
                            unkId: unkId,
                            continuationPrefix: continuationPrefix,
                            maxInputCharsPerWord: maxInputCharsPerWord,
                            into: &out
                        )
                    }
            }
        }
        return out
    }

    private enum Section {
        case added(Int32)
        case text(ArraySlice<Unicode.Scalar>)
    }

    /// DictionarySplitter mirror: at each position take the longest matching
    /// added-token literal (contents are ASCII, so the JS UTF-16-unit trie walk
    /// and this scalar walk agree).
    private func splitOnAddedTokens(_ scalars: [Unicode.Scalar]) -> [Section] {
        var sections: [Section] = []
        var start = 0
        var i = 0
        while i < scalars.count {
            var best: (length: Int, id: Int32)?
            for token in added where token.scalars.count > (best?.length ?? 0) {
                let end = i + token.scalars.count
                if end <= scalars.count, scalars[i ..< end].elementsEqual(token.scalars) {
                    best = (token.scalars.count, token.id)
                }
            }
            if let best {
                if i > start { sections.append(.text(scalars[start ..< i])) }
                sections.append(.added(best.id))
                i += best.length
                start = i
            } else {
                i += 1
            }
        }
        if start < scalars.count { sections.append(.text(scalars[start...])) }
        return sections
    }
}
