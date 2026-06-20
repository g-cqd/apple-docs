// Hidden self-verification verb for Stage-1 native semantic retrieval:
//
//   ad-cli _semantic-probe <query> --db <PATH> [--topk N]
//
// Loads the potion-retrieval-32M embedder from the db dir's
// `resources/models/minishlab/potion-retrieval-32M` (the ADMX matrix artifact +
// the sha-pinned tokenizer.json, parsed the same way embedder-native.js's
// loadTokenizerConfig does), runs `Semantic.candidates`, and prints
// `[{"documentId":…,"distance":…,"score":…}]` via the same JSON stringifier the
// read verbs use. NOT a shipped verb — it exists to compare native output
// against the JS `semanticCandidates` oracle bit-for-bit.

import ADEmbed
import ADSemantic
import ADStorage
import ArgumentParser
import Foundation

struct SemanticProbeCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "_semantic-probe",
        abstract: "Stage-1 semantic candidate retrieval probe (JS-oracle verification).",
        shouldDisplay: false)

    @Argument(help: "The search query to embed and retrieve semantic candidates for.")
    var query: String

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Number of document candidates to return (default 50).")
    var topk: Int = 50

    func run() throws {
        guard let connection = StorageConnection(path: corpus.db) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(corpus.db)\n".utf8))
            throw ExitCode(1)
        }

        // <dataDir> is the directory CONTAINING apple-docs.db; the model lives at
        // <dataDir>/resources/models/minishlab/potion-retrieval-32M.
        let dataDir = (corpus.db as NSString).deletingLastPathComponent
        let modelDir = dataDir + "/resources/models/minishlab/potion-retrieval-32M"

        let embedder: Embedder
        do {
            embedder = try loadPotionEmbedder(modelDir: modelDir)
        } catch {
            FileHandle.standardError.write(Data("ad-cli: embedder load failed: \(error)\n".utf8))
            throw ExitCode(1)
        }

        let candidates = Semantic.candidates(connection, embedder: embedder, query: query, topK: topk)
        print(renderCandidatesJSON(candidates))
    }
}

/// `[{"documentId":…,"distance":…,"score":…}]` matching the JS oracle's array
/// shape. `score` is a JSON number; integral scores print bare (the JS
/// `JSON.stringify` of an integral float), non-integral via the shortest
/// round-trippable Double description. A minimal inline renderer (this hidden
/// self-verify probe carries no projection-bridge dependency).
func renderCandidatesJSON(_ candidates: [SemanticCandidate]) -> String {
    if candidates.isEmpty { return "[]" }
    var out = "[\n"
    for (index, candidate) in candidates.enumerated() {
        out += "  {\n"
        out += "    \"documentId\": \(candidate.documentId),\n"
        out += "    \"distance\": \(candidate.distance),\n"
        out += "    \"score\": \(renderScore(candidate.score))\n"
        out += index == candidates.count - 1 ? "  }\n" : "  },\n"
    }
    out += "]"
    return out
}

/// One score as `JSON.stringify` would render it: an integral finite value with
/// no decimal point, else the shortest round-trippable Double description.
private func renderScore(_ value: Double) -> String {
    if value.isFinite, value.rounded(.towardZero) == value,
        value >= -9.223_372_036_854_775_8e18, value < 9.223_372_036_854_775_8e18
    {
        return String(Int64(value))
    }
    return String(value)
}

// MARK: - embedder loading (mirrors embedder-native.js loadTokenizerConfig)

enum EmbedderLoadError: Error, CustomStringConvertible {
    case matrixMissing(String)
    case tokenizerUnreadable(String)
    case tokenizerMalformed(String)
    case matrixLoad(MatrixArtifact.LoadError)

    var description: String {
        switch self {
        case .matrixMissing(let path): return "matrix artifact missing at \(path)"
        case .tokenizerUnreadable(let path): return "tokenizer.json unreadable at \(path)"
        case .tokenizerMalformed(let reason): return "tokenizer.json malformed: \(reason)"
        case .matrixLoad(let error): return "matrix artifact load failed: \(error)"
        }
    }
}

/// Build the potion embedder: the ADMX matrix (`matrix-v1.admx`) + a `Tokenizer`
/// from the sha-pinned `tokenizer.json` (vocab id-ordered, added tokens, unk,
/// continuing-subword prefix, max-input-chars-per-word) — the same fields
/// embedder-native.js extracts, so the native embed is bit-identical.
func loadPotionEmbedder(modelDir: String) throws -> Embedder {
    let matrixPath = modelDir + "/matrix-v1.admx"
    guard FileManager.default.fileExists(atPath: matrixPath) else {
        throw EmbedderLoadError.matrixMissing(matrixPath)
    }
    let matrix: MatrixArtifact
    do {
        matrix = try MatrixArtifact(path: matrixPath)
    } catch {
        // `MatrixArtifact.init` has typed throws (LoadError), so `error` is that type.
        throw EmbedderLoadError.matrixLoad(error)
    }

    let tokenizerPath = modelDir + "/tokenizer.json"
    guard let data = FileManager.default.contents(atPath: tokenizerPath) else {
        throw EmbedderLoadError.tokenizerUnreadable(tokenizerPath)
    }
    let config: TokenizerJSON
    do {
        config = try JSONDecoder().decode(TokenizerJSON.self, from: data)
    } catch {
        throw EmbedderLoadError.tokenizerMalformed("\(error)")
    }

    // vocab: { token: id } → an id-ordered token array (the generator guarantees
    // contiguous ids; place each token at its id index, matching the JS
    // loadTokenizerConfig contiguity check).
    let vocabPairs = config.model.vocab
    var vocab = [String](repeating: "", count: vocabPairs.count)
    var seen = [Bool](repeating: false, count: vocabPairs.count)
    for (token, id) in vocabPairs {
        guard id >= 0, id < vocabPairs.count, !seen[id] else {
            throw EmbedderLoadError.tokenizerMalformed("vocab ids are not contiguous at \(id)")
        }
        vocab[id] = token
        seen[id] = true
    }

    let added = config.addedTokens.map { Tokenizer.AddedToken(content: $0.content, id: Int32($0.id)) }

    let tokenizer = Tokenizer(
        vocab: vocab,
        addedTokens: added,
        unkToken: config.model.unkToken ?? "[UNK]",
        continuingSubwordPrefix: config.model.continuingSubwordPrefix ?? "##",
        maxInputCharsPerWord: config.model.maxInputCharsPerWord ?? 100)
    return Embedder(tokenizer: tokenizer, matrix: matrix)
}

/// The tokenizer.json subset the embedder needs (the same fields
/// embedder-native.js's loadTokenizerConfig reads). Decoded with `Codable` —
/// a typed struct, not a generic JSON tree, in this const-extracted command file.
private struct TokenizerJSON: Decodable {
    struct Model: Decodable {
        let vocab: [String: Int]
        let unkToken: String?
        let continuingSubwordPrefix: String?
        let maxInputCharsPerWord: Int?

        enum CodingKeys: String, CodingKey {
            case vocab
            case unkToken = "unk_token"
            case continuingSubwordPrefix = "continuing_subword_prefix"
            case maxInputCharsPerWord = "max_input_chars_per_word"
        }
    }

    struct AddedToken: Decodable {
        let id: Int
        let content: String
    }

    let model: Model
    let addedTokens: [AddedToken]

    enum CodingKeys: String, CodingKey {
        case model
        case addedTokens = "added_tokens"
    }
}
