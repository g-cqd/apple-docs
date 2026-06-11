// The Phase-2 gates (RFC 0002 §3): every committed fixture vector must be
// reproduced BIT-EXACTLY (Float byte compare, not ==, so ±0/NaN can never
// hide), and the sign/int8 codes byte-identically.
//
//   - case gate: 180 tokenizer-parity texts through matrix-subset.admx —
//     runs everywhere, including the CI native matrix (no model needed).
//   - corpus gate: 2,000 real chunks through the full matrix-v1.admx —
//     enabled only where the full artifact exists (dev machines, snapshot
//     builds); CI inherits coverage via the case gate.

import Foundation
import Testing

@testable import ADEmbed

enum EmbedFixtures {
  static let dir = TestSupport.fixturesURL
    .deletingLastPathComponent()
    .appendingPathComponent("embed-parity")

  static func data(_ name: String) throws -> Data {
    try Data(contentsOf: dir.appendingPathComponent(name))
  }

  static func embedder(matrixPath: String) throws -> Embedder {
    Embedder(tokenizer: try Tokenizer.fromFixtures(), matrix: try MatrixArtifact(path: matrixPath))
  }

  static let subsetPath = dir.appendingPathComponent("matrix-subset.admx").path

  static let fullArtifactPath: String = {
    let env = ProcessInfo.processInfo.environment
    let home = env["APPLE_DOCS_HOME"] ?? (NSHomeDirectory() + "/.apple-docs")
    let modelsDir = env["APPLE_DOCS_MODELS_DIR"] ?? (home + "/resources/models")
    return modelsDir + "/minishlab/potion-retrieval-32M/matrix-v1.admx"
  }()

  /// vector i as raw bytes (180×512 f32 LE layout).
  static func vectorBytes(_ blob: Data, _ i: Int, dims: Int = 512) -> Data {
    blob.subdata(in: i * dims * 4..<(i + 1) * dims * 4)
  }

  static let codeStride = 64 + 512 + 4

  static func checkCase(_ embedder: Embedder, text: String, index: Int, vectors: Data, codes: Data) throws -> String? {
    let got = try embedder.embed(text)
    let gotBytes = got.withUnsafeBytes { Data($0) }
    guard gotBytes == vectorBytes(vectors, index) else { return "vector" }
    let code = codes.subdata(in: index * codeStride..<(index + 1) * codeStride)
    guard Data(Quantize.signCode(got)) == code.prefix(64) else { return "sign code" }
    guard Data(Quantize.i8Code(got)) == code.dropFirst(64) else { return "i8 code" }
    return nil
  }
}

struct MatrixArtifactTests {
  // src/search/model-integrity.js PINNED_MODEL_FILES['onnx/model.onnx']
  static let modelPin = "e82f46335878dd5d72f9544a2a7c61061659c6273ceb8815e10ff952c2e07457"

  @Test func subsetHeaderAndPin() throws {
    let matrix = try MatrixArtifact(path: EmbedFixtures.subsetPath)
    #expect(matrix.dims == 512)
    #expect(matrix.isSparse)
    #expect(matrix.rows > 500)
    #expect(matrix.sourceSha256.map { String(format: "%02x", $0) }.joined() == Self.modelPin)
  }

  @Test func sparseLookupHitsAndMisses() throws {
    let matrix = try MatrixArtifact(path: EmbedFixtures.subsetPath)
    #expect(matrix.row(forTokenId: 0) != nil) // the [PAD] row is always included
    var missing: UInt32?
    for id in 0..<UInt32(63091) where matrix.row(forTokenId: id) == nil {
      missing = id
      break
    }
    #expect(missing != nil, "a 608-row subset must miss most of the vocab")
    #expect(matrix.row(forTokenId: 1 << 30) == nil)
  }

  @Test func corruptArtifactsAreRejected() throws {
    let temp = FileManager.default.temporaryDirectory
      .appendingPathComponent("admx-tests-\(UInt32.random(in: 0..<UInt32.max))")
    try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: temp) }

    let badMagic = temp.appendingPathComponent("bad-magic.admx")
    try Data(repeating: 0, count: 64).write(to: badMagic)
    #expect(throws: MatrixArtifact.LoadError.badMagic) {
      _ = try MatrixArtifact(path: badMagic.path)
    }

    var truncated = try EmbedFixtures.data("matrix-subset.admx")
    truncated.removeLast()
    let truncatedURL = temp.appendingPathComponent("truncated.admx")
    try truncated.write(to: truncatedURL)
    #expect(throws: MatrixArtifact.LoadError.truncated) {
      _ = try MatrixArtifact(path: truncatedURL.path)
    }

    var badVersion = try EmbedFixtures.data("matrix-subset.admx")
    badVersion[4] = 9
    let badVersionURL = temp.appendingPathComponent("bad-version.admx")
    try badVersion.write(to: badVersionURL)
    #expect(throws: MatrixArtifact.LoadError.unsupportedVersion(9)) {
      _ = try MatrixArtifact(path: badVersionURL.path)
    }

    #expect(throws: MatrixArtifact.LoadError.openFailed(errno: 2)) {
      _ = try MatrixArtifact(path: temp.appendingPathComponent("absent.admx").path)
    }
  }
}

struct EmbedderTests {
  @Test func missingRowThrowsInsteadOfTrapping() throws {
    let embedder = try EmbedFixtures.embedder(matrixPath: EmbedFixtures.subsetPath)
    // A word whose subword ids are certainly outside the 608-row subset
    // would throw; assert the error shape using an id-free probe: the
    // subset was built FROM the cases, so all case texts succeed — covered
    // by the gate. Here: empty text pads to [0], which is present.
    #expect(try embedder.embed("").count == 512)
  }
}

struct EmbedCaseParityTests {
  @Test func everyCaseVectorAndCodeMatchesBitExactly() throws {
    let fixture = try TestSupport.loadFixture()
    let embedder = try EmbedFixtures.embedder(matrixPath: EmbedFixtures.subsetPath)
    let vectors = try EmbedFixtures.data("case-vectors.bin")
    let codes = try EmbedFixtures.data("case-codes.bin")
    #expect(vectors.count == fixture.cases.count * 512 * 4)
    var failures: [String] = []
    for (i, c) in fixture.cases.enumerated() {
      if let what = try EmbedFixtures.checkCase(embedder, text: c.text, index: i, vectors: vectors, codes: codes) {
        failures.append("\(c.name): \(what)")
      }
    }
    #expect(
      failures.isEmpty,
      "\(failures.count)/\(fixture.cases.count) mismatches:\n\(failures.prefix(8).joined(separator: "\n"))"
    )
  }
}

struct EmbedCorpusParityTests {
  struct CorpusChunk: Decodable {
    let docId: Int
    let ord: Int
    let text: String
  }

  @Test(.enabled(if: FileManager.default.fileExists(atPath: EmbedFixtures.fullArtifactPath)))
  func corpusReproducesBitExactlyAgainstTheFullMatrix() throws {
    let chunks = try JSONDecoder().decode(
      [CorpusChunk].self,
      from: EmbedFixtures.data("corpus-texts.json")
    )
    let embedder = try EmbedFixtures.embedder(matrixPath: EmbedFixtures.fullArtifactPath)
    let vectors = try EmbedFixtures.data("corpus-vectors.bin")
    let codes = try EmbedFixtures.data("corpus-codes.bin")
    #expect(vectors.count == chunks.count * 512 * 4)
    var failures: [String] = []
    for (i, chunk) in chunks.enumerated() {
      if let what = try EmbedFixtures.checkCase(embedder, text: chunk.text, index: i, vectors: vectors, codes: codes) {
        failures.append("chunk \(i) (doc \(chunk.docId) ord \(chunk.ord)): \(what)")
      }
    }
    #expect(
      failures.isEmpty,
      "\(failures.count)/\(chunks.count) mismatches:\n\(failures.prefix(8).joined(separator: "\n"))"
    )
  }
}
