// Batch result payload: count × [u32 len LE][bytes], with len = 0xFFFFFFFF
// marking a null/failed entry. The per-item request layout is each
// export's own concern.

import Dispatch

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

/// 0xFFFFFFFF marks a null/failed entry in length-prefixed batch payloads
/// and nullable-string request fields (empty is distinct from null).
public let nullSentinel: UInt32 = 0xFFFF_FFFF

/// Below this, batches stay sequential — the dispatch fan costs more than
/// it saves.
public let batchParallelThreshold = 8

/// Distinct-index concurrent writes through a shared buffer (each
/// iteration owns exactly results[i]).
private struct ResultsCell: @unchecked Sendable {
    let base: UnsafeMutableBufferPointer<[UInt8]?>
}

/// Render `count` independent jobs into an indexed results array,
/// concurrently above the threshold. `job` is a pure function over the
/// request spans, which stay valid for the whole synchronous call;
/// returning false leaves that entry null.
public func renderIndexed(_ count: Int, _ job: @Sendable (Int, inout [UInt8]) -> Bool) -> [[UInt8]?] {
    var results = [[UInt8]?](repeating: nil, count: count)
    if count >= batchParallelThreshold {
        results.withUnsafeMutableBufferPointer { buffer in
            let cell = ResultsCell(base: UnsafeMutableBufferPointer(rebasing: buffer[...]))
            DispatchQueue.concurrentPerform(iterations: count) { i in
                var out: [UInt8] = []
                if job(i, &out) { cell.base[i] = out }
            }
        }
    } else {
        for i in 0 ..< count {
            var out: [UInt8] = []
            if job(i, &out) { results[i] = out }
        }
    }
    return results
}

/// Frames `count × [u32 len][bytes]` into one result block, nullSentinel
/// for failed entries. nil only on allocation failure.
public func lenPrefixedPayload(_ results: [[UInt8]?]) -> UnsafeMutableRawPointer? {
    var payloadCount = 0
    for result in results { payloadCount += 4 + (result?.count ?? 0) }
    guard let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: payloadCount) else {
        return nil
    }
    var offset = 0
    for result in results {
        if let result {
            payload.storeBytes(of: UInt32(result.count).littleEndian, toByteOffset: offset, as: UInt32.self)
            offset += 4
            if result.count > 0 {
                result.withUnsafeBytes { src in
                    UnsafeMutableRawBufferPointer(rebasing: payload[offset ..< offset + result.count])
                        .copyMemory(from: src)
                }
                offset += result.count
            }
        } else {
            payload.storeBytes(of: nullSentinel.littleEndian, toByteOffset: offset, as: UInt32.self)
            offset += 4
        }
    }
    return base
}
