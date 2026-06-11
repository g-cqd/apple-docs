// Boundary + round-trip tests for the ad_embed_* surface. Serialized: the
// exports share one process-wide embedder (by design), so tests must not
// interleave init/reset.

import Foundation
import Testing

@testable import ADCore

private let fixturesRoot = URL(fileURLWithPath: #filePath)
  .deletingLastPathComponent() // ADCoreTests
  .deletingLastPathComponent() // Tests
  .deletingLastPathComponent() // swift
  .deletingLastPathComponent() // repo
  .appendingPathComponent("test/fixtures")

private struct Decoded {
  let status: UInt32
  let formatId: UInt8
  let payload: [UInt8]

  var message: String { String(decoding: payload, as: UTF8.self) }
}

private func decode(_ ptr: UnsafeMutableRawPointer?) -> Decoded? {
  guard let ptr else { return nil }
  defer { adFree(ptr) }
  let len = Int(UInt64(littleEndian: ptr.load(fromByteOffset: 0, as: UInt64.self)))
  return Decoded(
    status: UInt32(littleEndian: ptr.load(fromByteOffset: 8, as: UInt32.self)),
    formatId: ptr.load(fromByteOffset: 12, as: UInt8.self),
    payload: [UInt8](UnsafeRawBufferPointer(start: ptr + 16, count: len)),
  )
}

private struct RequestWriter {
  var bytes: [UInt8] = []

  mutating func u32(_ value: UInt32) {
    withUnsafeBytes(of: value.littleEndian) { bytes.append(contentsOf: $0) }
  }

  mutating func string(_ value: String) {
    let utf8 = Array(value.utf8)
    u32(UInt32(utf8.count))
    bytes.append(contentsOf: utf8)
  }

  func call(_ fn: (UnsafePointer<UInt8>?, Int) -> UnsafeMutableRawPointer?) -> Decoded? {
    bytes.withUnsafeBufferPointer { decode(fn($0.baseAddress, $0.count)) }
  }
}

private enum Fixture {
  struct Case: Decodable {
    let name: String
    let text: String
  }

  struct Cases: Decodable {
    let cases: [Case]
  }

  static let subsetMatrixPath = fixturesRoot.appendingPathComponent("embed-parity/matrix-subset.admx").path

  static func vocab() throws -> [String] {
    try JSONDecoder().decode(
      [String].self,
      from: Data(contentsOf: fixturesRoot.appendingPathComponent("tokenizer-parity/vocab.json")),
    )
  }

  static func cases() throws -> [Case] {
    try JSONDecoder().decode(
      Cases.self,
      from: Data(contentsOf: fixturesRoot.appendingPathComponent("tokenizer-parity/cases.json")),
    ).cases
  }

  static func caseVectors() throws -> Data {
    try Data(contentsOf: fixturesRoot.appendingPathComponent("embed-parity/case-vectors.bin"))
  }

  /// The 5 potion added tokens (pinned by the committed tokenizer.json).
  static let added: [(id: UInt32, content: String)] = [
    (0, "[PAD]"), (1, "[UNK]"), (2, "[CLS]"), (3, "[SEP]"), (4, "[MASK]"),
  ]

  static func initRequest(matrixPath: String = subsetMatrixPath, vocab: [String]) -> RequestWriter {
    var w = RequestWriter()
    w.u32(1)
    w.string(matrixPath)
    w.u32(UInt32(vocab.count))
    for token in vocab { w.string(token) }
    w.u32(UInt32(added.count))
    for token in added {
      w.u32(token.id)
      w.string(token.content)
    }
    w.string("[UNK]")
    w.string("##")
    w.u32(100)
    return w
  }

  static func batchRequest(_ texts: [String]) -> RequestWriter {
    var w = RequestWriter()
    w.u32(1)
    w.u32(UInt32(texts.count))
    for text in texts { w.string(text) }
    return w
  }
}

@Suite(.serialized)
struct EmbedExportsTests {
  @Test func initThenBatchReproducesFixtureVectors() throws {
    adEmbedReset()
    let vocab = try Fixture.vocab()
    let initResult = Fixture.initRequest(vocab: vocab).call(adEmbedInit)
    #expect(initResult?.status == 0, initResult.map { Comment(rawValue: $0.message) } ?? "no result")
    let dims = initResult!.payload.withUnsafeBytes { UInt32(littleEndian: $0.load(as: UInt32.self)) }
    #expect(dims == 512)

    let cases = try Fixture.cases()
    let vectors = try Fixture.caseVectors()
    let sample = [0, 7, 42, 100, cases.count - 1]
    let batch = Fixture.batchRequest(sample.map { cases[$0].text }).call(adEmbedBatch)
    #expect(batch?.status == 0, batch.map { Comment(rawValue: $0.message) } ?? "no result")
    let payload = batch!.payload
    #expect(payload.count == sample.count * 512 * 4)
    for (k, caseIndex) in sample.enumerated() {
      let got = Array(payload[k * 2048..<(k + 1) * 2048])
      let want = [UInt8](vectors.subdata(in: caseIndex * 2048..<(caseIndex + 1) * 2048))
      #expect(got == want, "case \(cases[caseIndex].name) diverged")
    }
  }

  @Test func emptyTextUsesPadRow() throws {
    adEmbedReset()
    _ = Fixture.initRequest(vocab: try Fixture.vocab()).call(adEmbedInit)
    let result = Fixture.batchRequest([""]).call(adEmbedBatch)
    #expect(result?.status == 0)
    #expect(result?.payload.count == 2048)
  }

  @Test func batchBeforeInitIsInvalid() {
    adEmbedReset()
    let result = Fixture.batchRequest(["hello"]).call(adEmbedBatch)
    #expect(result?.status == 1)
    #expect(result?.message.contains("not initialized") == true)
  }

  @Test func reInitIsIdempotentIgnore() throws {
    adEmbedReset()
    let vocab = try Fixture.vocab()
    let first = Fixture.initRequest(vocab: vocab).call(adEmbedInit)
    #expect(first?.status == 0)
    // Second init — even with a bogus path — reports the existing state.
    let second = Fixture.initRequest(matrixPath: "/nonexistent.admx", vocab: vocab).call(adEmbedInit)
    #expect(second?.status == 1) // bogus artifact rejected before adoption
    let third = Fixture.initRequest(vocab: vocab).call(adEmbedInit)
    #expect(third?.status == 0)
    #expect(third?.payload == first?.payload)
  }

  @Test func truncatedAndMalformedRequestsAreInvalid() {
    adEmbedReset()
    var truncated = RequestWriter()
    truncated.u32(1)
    #expect(truncated.call(adEmbedInit)?.status == 1)

    var wrongVersion = RequestWriter()
    wrongVersion.u32(9)
    wrongVersion.u32(0)
    #expect(wrongVersion.call(adEmbedBatch)?.status == 1)

    var oversized = RequestWriter()
    oversized.u32(1)
    oversized.u32(70000)
    #expect(oversized.call(adEmbedBatch)?.status == 1)
  }

  @Test func missingUnkIsInvalidNotATrap() {
    adEmbedReset()
    var w = RequestWriter()
    w.u32(1)
    w.string(Fixture.subsetMatrixPath)
    w.u32(2)
    w.string("a")
    w.string("b")
    w.u32(0)
    w.string("[UNK]")
    w.string("##")
    w.u32(100)
    let result = w.call(adEmbedInit)
    #expect(result?.status == 1)
    #expect(result?.message.contains("unk token") == true)
  }

  @Test func rowMissingFromSparseSubsetIsInternalError() throws {
    adEmbedReset()
    let vocab = try Fixture.vocab()
    _ = Fixture.initRequest(vocab: vocab).call(adEmbedInit)
    // Find a plain-ascii vocab token whose own id is outside the 608-row
    // subset: it tokenizes to itself, so embedding it must miss the matrix.
    var found = false
    for id in stride(from: 30000, to: 40000, by: 137) {
      let token = vocab[id]
      guard token.count > 3, token.allSatisfy({ $0.isLowercase && $0.isASCII }) else { continue }
      let result = Fixture.batchRequest([token]).call(adEmbedBatch)
      if result?.status == 2 {
        #expect(result?.message.contains("embed failed") == true)
        found = true
        break
      }
    }
    #expect(found, "expected at least one out-of-subset token to trip the missing-row path")
  }
}
