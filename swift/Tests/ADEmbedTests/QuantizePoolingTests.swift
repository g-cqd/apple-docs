// Stage units for the bit-exact embed pipeline: quantizer edge semantics
// (sign of ±0/NaN, JS Math.round halves, amax=0) and pooling arithmetic.

import Testing

@testable import ADEmbed

struct QuantizeTests {
  @Test func signCodeEdges() {
    // bits: 0 (0>=0), -0.0 (>=0 in both languages), 1, -1, -2, 3, NaN, -4
    let code = Quantize.signCode([0, -0.0, 1, -1, -2, 3, .nan, -4])
    #expect(code == [0b0010_0111])
  }

  @Test func i8CodeZeroVector() {
    // amax = 0 → inv = 0 → all codes 0; scale stored as f32 1.0 LE.
    let code = Quantize.i8Code([0, 0])
    #expect(code == [0, 0, 0x00, 0x00, 0x80, 0x3F])
  }

  @Test func i8CodeHalvesAndClamp() {
    // amax = 254 → inv = 0.5: 1.5 → 2 (half up), -1.5 → -1 (half toward +∞),
    // 254 → 127 exactly; scale = 254/127 = 2.0.
    let code = Quantize.i8Code([3, -3, 254])
    #expect(code[0] == 2)
    #expect(code[1] == UInt8(bitPattern: -1))
    #expect(code[2] == 127)
    #expect(Array(code[3...]) == [0x00, 0x00, 0x00, 0x40])
  }

  @Test func jsRoundMatchesEcma() {
    #expect(Quantize.jsRound(0.5) == 1)
    #expect(Quantize.jsRound(-0.5) == 0)
    #expect(Quantize.jsRound(-1.5) == -1)
    #expect(Quantize.jsRound(2.5) == 3)
    // The floor(x+0.5) double-rounding trap: JS yields 0 here.
    #expect(Quantize.jsRound(0.49999999999999994) == 0)
    #expect(Quantize.jsRound(-0.49999999999999994) == 0)
  }
}

struct PoolingTests {
  @Test func meanAndNormalizeExactCase() {
    // rows [3,0] and [0,4]: mean [1.5,2], norm 2.5 → [0.6, 0.8] — every
    // step exact in f32 except the final divisions, which are correctly
    // rounded to the same values as the literals.
    let a: [Float] = [3, 0]
    let b: [Float] = [0, 4]
    var out = [Float](repeating: 0, count: 2)
    a.withUnsafeBufferPointer { ap in
      b.withUnsafeBufferPointer { bp in
        Pooling.meanPoolNormalized(rows: [ap.baseAddress!, bp.baseAddress!], dims: 2, into: &out)
      }
    }
    #expect(out == [0.6, 0.8])
  }

  @Test func singleRowIsItsOwnNormalizedDirection() {
    let row: [Float] = [3, 4]
    var out = [Float](repeating: 0, count: 2)
    row.withUnsafeBufferPointer { rp in
      Pooling.meanPoolNormalized(rows: [rp.baseAddress!], dims: 2, into: &out)
    }
    #expect(out == [0.6, 0.8])
  }
}
