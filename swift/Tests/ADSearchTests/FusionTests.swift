// Fixtures printed from the normative JS implementation via bun; the decimal
// literals are JS shortest-round-trip strings, so the Swift doubles are
// bit-identical to the JS values.

import Testing
@testable import ADSearch

@Test func weightedRRFMatchesJS() {
  // JS: weightedRRF([{ranked:[a,b,c],weight:1.0},{ranked:[b,d],weight:0.6}])
  // ids interned first-seen: a=0 b=1 c=2 d=3
  let out = Fusion.weightedRRF(
    [
      .init(ranked: [0, 1, 2], weight: 1.0),
      .init(ranked: [1, 3], weight: 0.6),
    ],
    idCount: 4,
  )
  #expect(out == [0.01639344262295082, 0.025965097831835007, 0.015873015873015872, 0.00967741935483871])
}

@Test func hybridMatchesJS() {
  // JS: hybridFusion with scores a:5 b:2 c:1 / b:0.9 d:0.1, k:60, beta:0.5
  let out = Fusion.hybrid(
    [
      .init(ranked: [0, 1, 2], weight: 1.0, scores: [5, 2, 1]),
      .init(ranked: [1, 3], weight: 0.6, scores: [0.9, 0.1]),
    ],
    idCount: 4,
    k: 60,
    beta: 0.5,
  )
  #expect(out == [0.5163934426229508, 0.45096509783183497, 0.015873015873015872, 0.00967741935483871])
}

@Test func hybridDegenerateScoresContributeNothing() {
  // JS: equal scores in list 2 → normalized range 0 → score term zero.
  // x=0, y=1; k:10, beta:0.25
  let out = Fusion.hybrid(
    [
      .init(ranked: [0, 1], weight: 0.7),
      .init(ranked: [1, 0], weight: 0.3, scores: [3, 3]),
    ],
    idCount: 2,
    k: 10,
    beta: 0.25,
  )
  #expect(out == [0.08863636363636362, 0.0856060606060606])
}

@Test func normalizeMirrorsJSGuards() {
  #expect(Fusion.normalize([]) == [])
  #expect(Fusion.normalize([7]) == [0])
  #expect(Fusion.normalize([2, 2, 2]) == [0, 0, 0])
  #expect(Fusion.normalize([1, 3]) == [0, 1])
}

private func runMMR(vectors: [[UInt8]?], lambda: Double, limit: Int) -> [UInt32] {
  let n = vectors.count
  let dim = vectors.compactMap { $0?.count }.first ?? 0
  var rows = [UInt8](repeating: 0, count: n * dim)
  var bitmap = [UInt8](repeating: 0, count: (n + 7) / 8)
  for (i, vec) in vectors.enumerated() {
    guard let vec else { continue }
    bitmap[i >> 3] |= UInt8(1 << (i & 7))
    for (j, byte) in vec.enumerated() { rows[i * dim + j] = byte }
  }
  return rows.withUnsafeBufferPointer { rowBuf in
    bitmap.withUnsafeBufferPointer { bitBuf in
      MMR.select(
        n: n, dim: dim,
        vectors: UnsafeRawBufferPointer(rowBuf),
        presence: UnsafeRawBufferPointer(bitBuf),
        lambda: lambda, limit: limit,
      )
    }
  }
}

@Test func mmrMatchesJSIdentityCase() {
  // JS fixture: p=[0b10101010,0xFF] q=[0b10101010,0x0F] r=[0,0] s=null,
  // lambda 0.7 → ["p","q","r","s"] (identity)
  let out = runMMR(
    vectors: [[0b1010_1010, 0xFF], [0b1010_1010, 0x0F], [0, 0], nil],
    lambda: 0.7, limit: 0,
  )
  #expect(out == [0, 1, 2, 3])
}

@Test func mmrDemotesDuplicates() {
  // JS fixture: p=q=[255,255], r=[0,0], s=null, lambda 0.3
  // → ["p","r","s","q"] with and without limit 3
  let vectors: [[UInt8]?] = [[255, 255], [255, 255], [0, 0], nil]
  #expect(runMMR(vectors: vectors, lambda: 0.3, limit: 0) == [0, 2, 3, 1])
  #expect(runMMR(vectors: vectors, lambda: 0.3, limit: 3) == [0, 2, 3, 1])
}

@Test func mmrFiveItems() {
  // JS fixture: a=[0b11110000] b=[0b11110001] c=[0b00001111] d=[0b00001110]
  // e=null, lambda 0.5 → ["a","c","e","b","d"]
  let out = runMMR(
    vectors: [[0b1111_0000], [0b1111_0001], [0b0000_1111], [0b0000_1110], nil],
    lambda: 0.5, limit: 0,
  )
  #expect(out == [0, 2, 4, 1, 3])
}

@Test func mmrTinyInputsAreIdentity() {
  #expect(runMMR(vectors: [[1], [2]], lambda: 0.5, limit: 0) == [0, 1])
  #expect(runMMR(vectors: [nil], lambda: 0.5, limit: 0) == [0])
  #expect(runMMR(vectors: [], lambda: 0.5, limit: 0) == [])
}
