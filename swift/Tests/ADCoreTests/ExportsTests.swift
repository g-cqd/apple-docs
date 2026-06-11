// Boundary tests: the @_cdecl surface must never trap — garbage, truncation,
// and out-of-range inputs all surface as status 1 buffers. Happy paths are
// pinned against the same JS-printed fixtures as ADSearchTests.

import Testing
@testable import ADCore

private struct Decoded {
  let status: UInt32
  let formatId: UInt8
  let payload: [UInt8]
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
  mutating func f64(_ value: Double) {
    withUnsafeBytes(of: value.bitPattern.littleEndian) { bytes.append(contentsOf: $0) }
  }
  mutating func pad8() {
    while bytes.count % 8 != 0 { bytes.append(0) }
  }

  func call(_ fn: (UnsafePointer<UInt8>?, Int) -> UnsafeMutableRawPointer?) -> Decoded? {
    bytes.withUnsafeBufferPointer { decode(fn($0.baseAddress, $0.count)) }
  }
}

private func fusionRequest(
  k: Double, beta: Double, idCount: UInt32,
  lists: [(ranked: [UInt32], weight: Double, scores: [Double]?)]
) -> RequestWriter {
  var w = RequestWriter()
  w.u32(UInt32(lists.count))
  w.u32(idCount)
  w.f64(k)
  w.f64(beta)
  for list in lists {
    w.u32(UInt32(list.ranked.count))
    w.u32(list.scores != nil ? 1 : 0)
    w.f64(list.weight)
  }
  for list in lists {
    for index in list.ranked { w.u32(index) }
  }
  w.pad8()
  for list in lists {
    for score in list.scores ?? [] { w.f64(score) }
  }
  return w
}

private func doubles(_ payload: [UInt8]) -> [Double] {
  payload.withUnsafeBufferPointer { raw in
    let buf = UnsafeRawBufferPointer(raw)
    return (0..<(payload.count / 8)).map {
      Double(bitPattern: UInt64(littleEndian: buf.baseAddress!.loadUnaligned(fromByteOffset: $0 * 8, as: UInt64.self)))
    }
  }
}

@Test func abiAndEchoRoundTrip() {
  #expect(adAbiVersion() == 1)
  let blob: [UInt8] = [9, 8, 7]
  let echoed = blob.withUnsafeBufferPointer { decode(adEcho($0.baseAddress, $0.count)) }
  #expect(echoed?.status == 0)
  #expect(echoed?.payload == blob)
  let bad = blob.withUnsafeBufferPointer { decode(adEcho($0.baseAddress, -2)) }
  #expect(bad?.status == 1)
}

@Test func rrfHappyPathMatchesJSFixture() {
  let request = fusionRequest(
    k: 60, beta: 0, idCount: 4,
    lists: [([0, 1, 2], 1.0, nil), ([1, 3], 0.6, nil)],
  )
  let result = request.call(adFusionRrf)
  #expect(result?.status == 0)
  #expect(doubles(result?.payload ?? []) == [0.01639344262295082, 0.025965097831835007, 0.015873015873015872, 0.00967741935483871])
}

@Test func hybridHappyPathMatchesJSFixture() {
  let request = fusionRequest(
    k: 60, beta: 0.5, idCount: 4,
    lists: [([0, 1, 2], 1.0, [5, 2, 1]), ([1, 3], 0.6, [0.9, 0.1])],
  )
  let result = request.call(adFusionHybrid)
  #expect(result?.status == 0)
  #expect(doubles(result?.payload ?? []) == [0.5163934426229508, 0.45096509783183497, 0.015873015873015872, 0.00967741935483871])
}

@Test func fusionRejectsGarbageNotTrap() {
  var garbage = RequestWriter()
  garbage.bytes = [UInt8](repeating: 0xAB, count: 11)
  #expect(garbage.call(adFusionRrf)?.status == 1)

  let empty = decode(adFusionRrf(nil, 0))
  #expect(empty?.status == 1)

  // Out-of-range ranked index.
  let badIndex = fusionRequest(k: 60, beta: 0, idCount: 2, lists: [([0, 5], 1.0, nil)])
  #expect(badIndex.call(adFusionRrf)?.status == 1)

  // Trailing junk.
  var trailing = fusionRequest(k: 60, beta: 0, idCount: 1, lists: [([0], 1.0, nil)])
  trailing.bytes.append(7)
  #expect(trailing.call(adFusionRrf)?.status == 1)

  // Truncated scores.
  var truncated = fusionRequest(k: 60, beta: 0.5, idCount: 1, lists: [([0], 1.0, [1.0])])
  truncated.bytes.removeLast(4)
  #expect(truncated.call(adFusionHybrid)?.status == 1)

  // Absurd list count.
  var absurd = RequestWriter()
  absurd.u32(2000)
  absurd.u32(1)
  absurd.f64(60)
  absurd.f64(0)
  #expect(absurd.call(adFusionRrf)?.status == 1)
}

private func mmrRequest(
  lambda: Double, limit: UInt32, dim: Int, vectors: [[UInt8]?]
) -> RequestWriter {
  var w = RequestWriter()
  w.u32(UInt32(vectors.count))
  w.u32(UInt32(dim))
  w.f64(lambda)
  w.u32(limit)
  w.u32(0)
  var bitmap = [UInt8](repeating: 0, count: (vectors.count + 7) / 8)
  for (i, vec) in vectors.enumerated() where vec != nil {
    bitmap[i >> 3] |= UInt8(1 << (i & 7))
  }
  w.bytes.append(contentsOf: bitmap)
  for vec in vectors {
    w.bytes.append(contentsOf: vec ?? [UInt8](repeating: 0, count: dim))
  }
  return w
}

private func u32s(_ payload: [UInt8]) -> [UInt32] {
  payload.withUnsafeBufferPointer { raw in
    let buf = UnsafeRawBufferPointer(raw)
    return (0..<(payload.count / 4)).map {
      UInt32(littleEndian: buf.baseAddress!.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self))
    }
  }
}

@Test func mmrHappyPathMatchesJSFixture() {
  // JS fixture: p=q=[255,255], r=[0,0], s=null, lambda 0.3 → [p,r,s,q]
  let request = mmrRequest(lambda: 0.3, limit: 0, dim: 2, vectors: [[255, 255], [255, 255], [0, 0], nil])
  let result = request.call(adFusionMmr)
  #expect(result?.status == 0)
  #expect(u32s(result?.payload ?? []) == [0, 2, 3, 1])
}

@Test func mmrRejectsMalformedNotTrap() {
  var short = RequestWriter()
  short.u32(4)
  #expect(short.call(adFusionMmr)?.status == 1)

  var huge = mmrRequest(lambda: 0.5, limit: 0, dim: 1, vectors: [[1]])
  huge.bytes.replaceSubrange(0..<4, with: withUnsafeBytes(of: UInt32(70000).littleEndian) { [UInt8]($0) })
  #expect(huge.call(adFusionMmr)?.status == 1)

  var trailing = mmrRequest(lambda: 0.5, limit: 0, dim: 1, vectors: [[1], [2], [3]])
  trailing.bytes.append(1)
  #expect(trailing.call(adFusionMmr)?.status == 1)
}
