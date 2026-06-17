// Reference dump tool: since embedding v2 the Swift tokenizer is its own
// reference, and scripts/gen-tokenizer-fixtures.mjs records ids from THIS
// tool instead of transformers.js. Not part of the shipped dylib; Foundation
// is fine here.
//
// usage: ad-embed-dump <tokenizer-parity-fixtures-dir>
//   stdin:  JSON array of texts
//   stdout: JSON { "behaviorVersion": n, "ids": [[Int32]] }

import ADEmbed
import Foundation

struct TokenizerJson: Decodable {
  struct Added: Decodable {
    let id: Int32
    let content: String
  }

  struct Model: Decodable {
    let unkToken: String
    let continuingSubwordPrefix: String
    let maxInputCharsPerWord: Int
  }

  let addedTokens: [Added]
  let model: Model
}

struct Output: Encodable {
  let behaviorVersion: UInt32
  let ids: [[Int32]]
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("ad-embed-dump: \(message)\n".utf8))
  exit(1)
}

guard CommandLine.arguments.count == 2 else {
  fail("usage: ad-embed-dump <tokenizer-parity-fixtures-dir>")
}
let fixturesDir = URL(fileURLWithPath: CommandLine.arguments[1])

do {
  let vocab = try JSONDecoder().decode(
    [String].self,
    from: Data(contentsOf: fixturesDir.appendingPathComponent("vocab.json"))
  )
  let decoder = JSONDecoder()
  decoder.keyDecodingStrategy = .convertFromSnakeCase
  let config = try decoder.decode(
    TokenizerJson.self,
    from: Data(
      contentsOf:
        fixturesDir
        .appendingPathComponent("models/minishlab/potion-retrieval-32M/tokenizer.json")
    )
  )
  let tokenizer = Tokenizer(
    vocab: vocab,
    addedTokens: config.addedTokens.map { Tokenizer.AddedToken(content: $0.content, id: $0.id) },
    unkToken: config.model.unkToken,
    continuingSubwordPrefix: config.model.continuingSubwordPrefix,
    maxInputCharsPerWord: config.model.maxInputCharsPerWord
  )

  let input = FileHandle.standardInput.readDataToEndOfFile()
  let texts = try JSONDecoder().decode([String].self, from: input)
  let output = Output(behaviorVersion: EmbedBehavior.version, ids: texts.map { tokenizer.encode($0) })
  FileHandle.standardOutput.write(try JSONEncoder().encode(output))
} catch {
  fail("\(error)")
}
