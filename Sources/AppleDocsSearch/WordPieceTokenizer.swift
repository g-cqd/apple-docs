import AemiJSONCore
import AppleDocsCore
import Foundation

/// Pure-Swift BERT WordPiece tokenizer matching HuggingFace `tokenizer.json` shipped with
/// `minishlab/potion-retrieval-32M` (`BertNormalizer -> BertPreTokenizer -> WordPiece`,
/// `add_special_tokens: false`).
public struct WordPieceTokenizer: Sendable {
    private let vocab: [String: Int]
    private let unknownID: Int
    private let continuationPrefix: String
    private let maxCharsPerWord: Int
    private let lowercase: Bool
    private let cleanText: Bool
    private let handleChinese: Bool
    private let stripAccents: Bool

    /// Parses a HuggingFace `tokenizer.json` payload using `g-cqd/AemiJSON`.
    public init(tokenizerJSON bytes: [UInt8]) throws(Model2VecError) {
        let root: JSON
        do {
            root = try AemiJSON.parse(bytes).root
        } catch {
            throw .unsupportedTokenizer("invalid JSON (\(error))")
        }
        let model = root["model"]
        guard model["type"].string == "WordPiece" else {
            throw .unsupportedTokenizer("expected WordPiece model")
        }
        let norm = root["normalizer"]
        if let normType = norm["type"].string, normType != "BertNormalizer" {
            throw .unsupportedTokenizer("expected BertNormalizer, found \(normType)")
        }
        let pre = root["pre_tokenizer"]
        if let preType = pre["type"].string, preType != "BertPreTokenizer" {
            throw .unsupportedTokenizer("expected BertPreTokenizer, found \(preType)")
        }
        guard let vocabObject = model["vocab"].object else {
            throw .unsupportedTokenizer("missing model.vocab object")
        }
        var map: [String: Int] = [:]
        map.reserveCapacity(vocabObject.count)
        for (token, value) in vocabObject {
            if let id = value.int { map[token] = id }
        }
        self.vocab = map
        let unkToken = model["unk_token"].string ?? "[UNK]"
        self.unknownID = map[unkToken] ?? 0
        self.continuationPrefix = model["continuing_subword_prefix"].string ?? "##"
        self.maxCharsPerWord = model["max_input_chars_per_word"].int ?? 100
        self.lowercase = norm["lowercase"].bool ?? true
        self.cleanText = norm["clean_text"].bool ?? true
        self.handleChinese = norm["handle_chinese_chars"].bool ?? true
        self.stripAccents = norm["strip_accents"].bool ?? self.lowercase
    }

    /// Number of vocabulary entries loaded from `tokenizer.json`.
    public var vocabularySize: Int { vocab.count }

    /// Encodes `text` into WordPiece token IDs without special `[CLS]`/`[SEP]` tokens.
    public func encode(_ text: String) -> [Int] {
        let normalized = normalize(text)
        let words = preTokenize(normalized)
        var ids: [Int] = []
        ids.reserveCapacity(words.count * 2)
        for word in words {
            encodeWordPiece(word, into: &ids)
        }
        return ids
    }

    private func normalize(_ text: String) -> String {
        var cleaned = ""
        cleaned.reserveCapacity(text.utf8.count)
        for scalar in text.unicodeScalars {
            let cp = scalar.value
            if cleanText, cp == 0 || cp == 0xFFFD || Self.isControl(scalar) {
                continue
            }
            if cleanText, Self.isWhitespace(scalar) {
                cleaned.append(" ")
                continue
            }
            if handleChinese, Self.isChinese(cp) {
                cleaned.append(" ")
                cleaned.unicodeScalars.append(scalar)
                cleaned.append(" ")
                continue
            }
            cleaned.unicodeScalars.append(scalar)
        }
        if stripAccents {
            let decomposed = cleaned.decomposedStringWithCanonicalMapping
            var stripped = ""
            stripped.reserveCapacity(decomposed.utf8.count)
            for scalar in decomposed.unicodeScalars where scalar.properties.generalCategory != .nonspacingMark {
                stripped.unicodeScalars.append(scalar)
            }
            cleaned = stripped
        }
        return lowercase ? cleaned.lowercased() : cleaned
    }

    private func preTokenize(_ text: String) -> [String] {
        var words: [String] = []
        var current = ""
        for scalar in text.unicodeScalars {
            if Self.isWhitespace(scalar) {
                if !current.isEmpty {
                    words.append(current)
                    current = ""
                }
            } else if Self.isPunctuation(scalar) {
                if !current.isEmpty {
                    words.append(current)
                    current = ""
                }
                words.append(String(scalar))
            } else {
                current.unicodeScalars.append(scalar)
            }
        }
        if !current.isEmpty { words.append(current) }
        return words
    }

    private func encodeWordPiece(_ word: String, into output: inout [Int]) {
        let scalars = Array(word.unicodeScalars)
        guard scalars.count <= maxCharsPerWord else {
            output.append(unknownID)
            return
        }
        var start = 0
        var pieces: [Int] = []
        while start < scalars.count {
            var end = scalars.count
            var matched: Int?
            while start < end {
                var sub = start > 0 ? continuationPrefix : ""
                for idx in start ..< end {
                    sub.unicodeScalars.append(scalars[idx])
                }
                if let id = vocab[sub] {
                    matched = id
                    break
                }
                end -= 1
            }
            guard let id = matched else {
                output.append(unknownID)
                return
            }
            pieces.append(id)
            start = end
        }
        output.append(contentsOf: pieces)
    }

    private static func isWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        let v = scalar.value
        return v == 0x20 || v == 0x09 || v == 0x0A || v == 0x0D || DocumentPlainText.isJSWhitespace(scalar)
    }

    private static func isControl(_ scalar: Unicode.Scalar) -> Bool {
        let v = scalar.value
        if v == 0x09 || v == 0x0A || v == 0x0D { return false }
        let cat = scalar.properties.generalCategory
        return cat == .control || cat == .format
    }

    private static func isPunctuation(_ scalar: Unicode.Scalar) -> Bool {
        let cp = scalar.value
        if (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126) {
            return true
        }
        switch scalar.properties.generalCategory {
            case .connectorPunctuation, .dashPunctuation, .openPunctuation,
                .closePunctuation, .initialPunctuation, .finalPunctuation, .otherPunctuation:
                return true
            default:
                return false
        }
    }

    private static func isChinese(_ cp: UInt32) -> Bool {
        (cp >= 0x4E00 && cp <= 0x9FFF)
            || (cp >= 0x3400 && cp <= 0x4DBF)
            || (cp >= 0x20000 && cp <= 0x2A6DF)
            || (cp >= 0x2A700 && cp <= 0x2B73F)
            || (cp >= 0x2B740 && cp <= 0x2B81F)
            || (cp >= 0x2B820 && cp <= 0x2CEAF)
            || (cp >= 0xF900 && cp <= 0xFAFF)
            || (cp >= 0x2F800 && cp <= 0x2FA1F)
    }
}
