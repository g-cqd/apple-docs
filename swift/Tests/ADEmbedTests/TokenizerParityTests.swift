// Token-id equality with transformers.js on 100% of the committed fixtures.
// A failure here after a fixture regeneration means the Swift pipeline no
// longer mirrors the JS engine — see the parity-trap notes in the ADEmbed
// sources before touching anything.

import Foundation
import Testing

@testable import ADEmbed

struct TokenizerParityTests {
  @Test func fixturesAreLoadableAndNonTrivial() throws {
    let fixture = try TestSupport.loadFixture()
    #expect(fixture.meta.model == "minishlab/potion-retrieval-32M")
    #expect(fixture.cases.count > 150)
  }

  @Test func everyFixtureCaseMatchesTransformersJS() throws {
    let tokenizer = try Tokenizer.fromFixtures()
    let fixture = try TestSupport.loadFixture()
    var failures: [String] = []
    for c in fixture.cases {
      let got = tokenizer.encode(c.text)
      if got != c.ids {
        failures.append("\(c.name): got \(got) want \(c.ids)")
      }
    }
    #expect(
      failures.isEmpty,
      "\(failures.count)/\(fixture.cases.count) mismatches:\n\(failures.prefix(8).joined(separator: "\n"))"
    )
  }
}
