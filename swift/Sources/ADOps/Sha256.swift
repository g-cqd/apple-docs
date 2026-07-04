// A compact, dependency-free SHA-256 (FIPS 180-4) so GhRelease's snapshot
// download verification produces the same 64-char lowercase hex digest the JS
// `Bun.CryptoHasher('sha256')` did — without pulling swift-crypto/CryptoKit
// (ADOps stays Foundation-only + Linux-static-binary friendly, RFC 0007 §5).

/// SHA-256 over a byte sequence → 64-char lowercase hex.
public enum SHA256Hex {
    public static func hex(_ message: [UInt8]) -> String {
        var hashState = initialState
        var padded = message
        let bitLength = UInt64(message.count) * 8
        padded.append(0x80)
        while padded.count % 64 != 56 { padded.append(0) }
        for shift in stride(from: 56, through: 0, by: -8) {
            padded.append(UInt8((bitLength >> UInt64(shift)) & 0xFF))
        }

        var block = [UInt32](repeating: 0, count: 64)
        var offset = 0
        while offset < padded.count {
            compress(&hashState, padded, offset, &block)
            offset += 64
        }
        return hashState.map { hex32($0) }.joined()
    }
}

/// Incremental SHA-256 for hashing a large file (or any chunked stream) without
/// buffering the whole input in memory — the multi-GB snapshot archive the
/// one-shot ``SHA256Hex/hex(_:)`` can't serve. Feed chunks with ``update(_:)``,
/// then ``finalize()`` → the 64-char lowercase hex. The digest is identical to
/// `SHA256Hex.hex` over the concatenated chunks (block boundaries are handled by
/// the internal `pending` buffer, which never exceeds 63 bytes between updates).
public struct SHA256Streaming {
    private var state = initialState
    /// Bytes not yet in a full 64-byte block (< 64).
    private var pending: [UInt8] = []
    private var totalBytes: UInt64 = 0
    private var block = [UInt32](repeating: 0, count: 64)

    public init() {}

    /// Feed the next chunk. Full 64-byte blocks are compressed straight from
    /// `bytes` (no whole-chunk copy); only the sub-block remainder is retained.
    public mutating func update(_ bytes: [UInt8]) {
        guard !bytes.isEmpty else { return }
        totalBytes &+= UInt64(bytes.count)
        var start = 0
        // Top off a partial block held from a previous update first.
        if !pending.isEmpty {
            let need = 64 - pending.count
            if bytes.count < need {
                pending.append(contentsOf: bytes)
                return
            }
            pending.append(contentsOf: bytes[0 ..< need])
            compress(&state, pending, 0, &block)
            pending.removeAll(keepingCapacity: true)
            start = need
        }
        var offset = start
        while bytes.count - offset >= 64 {
            compress(&state, bytes, offset, &block)
            offset += 64
        }
        if offset < bytes.count { pending.append(contentsOf: bytes[offset ..< bytes.count]) }
    }

    /// Append the FIPS 180-4 padding (0x80, zero-fill to 56 mod 64, 64-bit
    /// big-endian bit length), compress the tail, and return the hex digest.
    public mutating func finalize() -> String {
        let bitLength = totalBytes &* 8
        var tail = pending
        tail.append(0x80)
        while tail.count % 64 != 56 { tail.append(0) }
        for shift in stride(from: 56, through: 0, by: -8) {
            tail.append(UInt8((bitLength >> UInt64(shift)) & 0xFF))
        }
        var offset = 0
        while offset < tail.count {
            compress(&state, tail, offset, &block)
            offset += 64
        }
        return state.map { hex32($0) }.joined()
    }
}

private let initialState: [UInt32] = [
    0x6a09_e667, 0xbb67_ae85, 0x3c6e_f372, 0xa54f_f53a,
    0x510e_527f, 0x9b05_688c, 0x1f83_d9ab, 0x5be0_cd19
]

private let roundConstants: [UInt32] = [
    0x428a_2f98, 0x7137_4491, 0xb5c0_fbcf, 0xe9b5_dba5, 0x3956_c25b, 0x59f1_11f1, 0x923f_82a4,
    0xab1c_5ed5, 0xd807_aa98, 0x1283_5b01, 0x2431_85be, 0x550c_7dc3, 0x72be_5d74, 0x80de_b1fe,
    0x9bdc_06a7, 0xc19b_f174, 0xe49b_69c1, 0xefbe_4786, 0x0fc1_9dc6, 0x240c_a1cc, 0x2de9_2c6f,
    0x4a74_84aa, 0x5cb0_a9dc, 0x76f9_88da, 0x983e_5152, 0xa831_c66d, 0xb003_27c8, 0xbf59_7fc7,
    0xc6e0_0bf3, 0xd5a7_9147, 0x06ca_6351, 0x1429_2967, 0x27b7_0a85, 0x2e1b_2138, 0x4d2c_6dfc,
    0x5338_0d13, 0x650a_7354, 0x766a_0abb, 0x81c2_c92e, 0x9272_2c85, 0xa2bf_e8a1, 0xa81a_664b,
    0xc24b_8b70, 0xc76c_51a3, 0xd192_e819, 0xd699_0624, 0xf40e_3585, 0x106a_a070, 0x19a4_c116,
    0x1e37_6c08, 0x2748_774c, 0x34b0_bcb5, 0x391c_0cb3, 0x4ed8_aa4a, 0x5b9c_ca4f, 0x682e_6ff3,
    0x748f_82ee, 0x78a5_636f, 0x84c8_7814, 0x8cc7_0208, 0x90be_fffa, 0xa450_6ceb, 0xbef9_a3f7,
    0xc671_78f2
]

private func rotr(_ value: UInt32, _ count: UInt32) -> UInt32 {
    (value >> count) | (value << (32 - count))
}

private func hex32(_ value: UInt32) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var out = [UInt8](repeating: 0, count: 8)
    for index in 0 ..< 8 {
        let nibble = Int((value >> UInt32((7 - index) * 4)) & 0xF)
        out[index] = digits[nibble]
    }
    return String(decoding: out, as: UTF8.self)
}

/// Compress one 64-byte block into the running state.
private func compress(_ state: inout [UInt32], _ data: [UInt8], _ offset: Int, _ w: inout [UInt32]) {
    for t in 0 ..< 16 {
        let base = offset + t * 4
        w[t] =
            (UInt32(data[base]) << 24) | (UInt32(data[base + 1]) << 16)
            | (UInt32(data[base + 2]) << 8) | UInt32(data[base + 3])
    }
    for t in 16 ..< 64 {
        let s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >> 3)
        let s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >> 10)
        w[t] = w[t - 16] &+ s0 &+ w[t - 7] &+ s1
    }

    var a = state[0]
    var b = state[1]
    var c = state[2]
    var d = state[3]
    var e = state[4]
    var f = state[5]
    var g = state[6]
    var h = state[7]
    for t in 0 ..< 64 {
        let sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
        let ch = (e & f) ^ (~e & g)
        let temp1 = h &+ sigma1 &+ ch &+ roundConstants[t] &+ w[t]
        let sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
        let maj = (a & b) ^ (a & c) ^ (b & c)
        let temp2 = sigma0 &+ maj
        h = g
        g = f
        f = e
        e = d &+ temp1
        d = c
        c = b
        b = a
        a = temp1 &+ temp2
    }
    state[0] &+= a
    state[1] &+= b
    state[2] &+= c
    state[3] &+= d
    state[4] &+= e
    state[5] &+= f
    state[6] &+= g
    state[7] &+= h
}
