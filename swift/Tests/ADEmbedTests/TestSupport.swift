// Fixture loading for the tokenizer-parity suite. Foundation is fine here:
// the no-Foundation rule applies to shipped targets, not tests.
//
// Fixtures live in the repo (test/fixtures/tokenizer-parity, committed by
// scripts/gen-tokenizer-fixtures.mjs) and are reached relative to #filePath —
// the CI native job runs `swift test` from a full checkout with no model or
// DATA_DIR, so the committed files are the only data source.

import ADEmbed
import Foundation

enum TestSupport {
  struct Meta: Decodable {
    let model: String
    let transformersVersion: String
    let tokenizerSha256: String
  }

  struct Case: Decodable {
    let name: String
    let text: String
    let ids: [Int32]
  }

  struct Fixture: Decodable {
    let meta: Meta
    let cases: [Case]
  }

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

  static let fixturesURL: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // ADEmbedTests
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // swift
    .deletingLastPathComponent()  // repo root
    .appendingPathComponent("test/fixtures/tokenizer-parity")

  static func loadFixture() throws -> Fixture {
    let data = try Data(contentsOf: fixturesURL.appendingPathComponent("cases.json"))
    return try JSONDecoder().decode(Fixture.self, from: data)
  }
}

extension Tokenizer {
  /// The potion tokenizer, built from the committed fixture artifacts —
  /// vocab from the id-ordered array, configuration from tokenizer.json
  /// (whose 63k-key vocab object is skipped, not materialized into
  /// canonical-equivalence-hazardous String keys).
  static func fromFixtures() throws -> Tokenizer {
    let vocab = try JSONDecoder().decode(
      [String].self,
      from: Data(contentsOf: TestSupport.fixturesURL.appendingPathComponent("vocab.json"))
    )
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    let config = try decoder.decode(
      TestSupport.TokenizerJson.self,
      from: Data(
        contentsOf: TestSupport.fixturesURL
          .appendingPathComponent("models/minishlab/potion-retrieval-32M/tokenizer.json")
      )
    )
    return Tokenizer(
      vocab: vocab,
      addedTokens: config.addedTokens.map { Tokenizer.AddedToken(content: $0.content, id: $0.id) },
      unkToken: config.model.unkToken,
      continuingSubwordPrefix: config.model.continuingSubwordPrefix,
      maxInputCharsPerWord: config.model.maxInputCharsPerWord
    )
  }
}
