// Fusion request codec. Byte layouts are shared verbatim — change both sides
// together and bump
// `abiVersion` on any layout change.
//
// rrf/hybrid request (all little-endian):
//   [u32 L][u32 U][f64 k][f64 beta]
//   L × { u32 rankedLen, u32 hasScores, f64 weight }
//   concatenated ranked u32 arrays
//   pad to 8
//   f64 score arrays for each hasScores list, in list order
// result payload: U × f64 fused scores (id-table order)
//
// mmr request:
//   [u32 N][u32 D][f64 lambda][u32 limit][u32 reserved]
//   ceil(N/8) presence bitmap (LSB-first)
//   N × D u8 vector rows
// result payload: N × u32 output permutation

import ADBase
import ADFCore
import ADSearch

private let maxLists = 1024
private let maxIds = 16_777_216
private let maxMmrItems = 65536
private let maxVectorBytes = 4096

@_cdecl("ad_fusion_rrf")
public func adFusionRrf(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  decodeAndFuse(ptr, len, hybrid: false)
}

@_cdecl("ad_fusion_hybrid")
public func adFusionHybrid(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  decodeAndFuse(ptr, len, hybrid: true)
}

private func request(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeRawBufferPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else { return nil }
  return UnsafeRawBufferPointer(start: ptr, count: len)
}

private func decodeAndFuse(_ ptr: UnsafePointer<UInt8>?, _ len: Int, hybrid: Bool) -> UnsafeMutableRawPointer? {
  guard let buf = request(ptr, len) else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(buf)
  guard let rawLists = reader.u32(), let rawIds = reader.u32(),
    let k = reader.f64(), let beta = reader.f64()
  else { return ResultBuffer.error(.invalidInput, "truncated fusion header") }
  let listCount = Int(rawLists)
  let idCount = Int(rawIds)
  guard listCount <= maxLists, idCount <= maxIds else {
    return ResultBuffer.error(.invalidInput, "fusion request out of bounds (L=\(listCount), U=\(idCount))")
  }

  var metas: [(rankedLen: Int, hasScores: Bool, weight: Double)] = []
  metas.reserveCapacity(listCount)
  for _ in 0..<listCount {
    guard let rankedLen = reader.u32(), let hasScores = reader.u32(), let weight = reader.f64() else {
      return ResultBuffer.error(.invalidInput, "truncated list metadata")
    }
    guard Int(rankedLen) <= idCount else {
      return ResultBuffer.error(.invalidInput, "ranked list length \(rankedLen) exceeds id count \(idCount)")
    }
    metas.append((Int(rankedLen), hasScores != 0, weight))
  }

  var rankedArrays: [[UInt32]] = []
  rankedArrays.reserveCapacity(listCount)
  for meta in metas {
    guard let byteLen = meta.rankedLen.checkedMultiplied(by: 4), let view = reader.bytes(byteLen) else {
      return ResultBuffer.error(.invalidInput, "truncated ranked array")
    }
    var ranked = [UInt32](repeating: 0, count: meta.rankedLen)
    for i in 0..<meta.rankedLen {
      let value = UInt32(littleEndian: view.loadUnaligned(fromByteOffset: i * 4, as: UInt32.self))
      guard value < UInt32(idCount) else {
        return ResultBuffer.error(.invalidInput, "ranked index \(value) out of range (U=\(idCount))")
      }
      ranked[i] = value
    }
    rankedArrays.append(ranked)
  }

  guard reader.align8() else { return ResultBuffer.error(.invalidInput, "truncated padding") }

  var lists: [Fusion.List] = []
  lists.reserveCapacity(listCount)
  for (index, meta) in metas.enumerated() {
    var scores: [Double]?
    if meta.hasScores {
      guard let byteLen = meta.rankedLen.checkedMultiplied(by: 8), let view = reader.bytes(byteLen) else {
        return ResultBuffer.error(.invalidInput, "truncated score array")
      }
      var values = [Double](repeating: 0, count: meta.rankedLen)
      for i in 0..<meta.rankedLen {
        let bits = view.loadUnaligned(fromByteOffset: i * 8, as: UInt64.self)
        values[i] = Double(bitPattern: UInt64(littleEndian: bits))
      }
      scores = values
    }
    lists.append(.init(ranked: rankedArrays[index], weight: meta.weight, scores: scores))
  }

  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes in fusion request")
  }

  let fused =
    hybrid
    ? Fusion.hybrid(lists, idCount: idCount, k: k, beta: beta)
    : Fusion.weightedRRF(lists, idCount: idCount, k: k)
  guard let payloadBytes = idCount.checkedMultiplied(by: 8) else {
    return ResultBuffer.error(.invalidInput, "fusion result size overflow (U=\(idCount))")
  }
  guard let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: payloadBytes) else {
    return nil
  }
  for i in 0..<idCount {
    payload.storeBytes(of: fused[i].bitPattern.littleEndian, toByteOffset: i * 8, as: UInt64.self)
  }
  return base
}

@_cdecl("ad_fusion_mmr")
public func adFusionMmr(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard let buf = request(ptr, len) else {
    return ResultBuffer.error(.invalidInput, "empty or oversized request (\(len) bytes)")
  }
  var reader = RequestReader(buf)
  guard let rawN = reader.u32(), let rawDim = reader.u32(), let lambda = reader.f64(),
    let rawLimit = reader.u32(), reader.u32() != nil
  else { return ResultBuffer.error(.invalidInput, "truncated mmr header") }
  let n = Int(rawN)
  let dim = Int(rawDim)
  guard n <= maxMmrItems, dim <= maxVectorBytes else {
    return ResultBuffer.error(.invalidInput, "mmr request out of bounds (N=\(n), D=\(dim))")
  }
  guard let presence = reader.bytes((n + 7) / 8) else {
    return ResultBuffer.error(.invalidInput, "truncated presence bitmap")
  }
  guard let vectors = reader.bytes(n * dim) else {
    return ResultBuffer.error(.invalidInput, "truncated vector rows")
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes in mmr request")
  }

  let order = MMR.select(
    n: n, dim: dim, vectors: vectors, presence: presence,
    lambda: lambda, limit: Int(rawLimit),
  )
  guard let payloadBytes = n.checkedMultiplied(by: 4) else {
    return ResultBuffer.error(.invalidInput, "mmr result size overflow (N=\(n))")
  }
  guard let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: payloadBytes) else {
    return nil
  }
  for i in 0..<n {
    payload.storeBytes(of: order[i].littleEndian, toByteOffset: i * 4, as: UInt32.self)
  }
  return base
}
