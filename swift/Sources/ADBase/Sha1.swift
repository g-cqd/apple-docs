// Pure-Swift SHA-1 (FIPS 180-1). ADBase is in the libAppleDocsCore dylib graph,
// which must stay zero-external-dependency, so we cannot pull swift-crypto here.
// SHA-1 is only used by SafePath's truncate-and-hash for oversized web path
// segments (rare), where the digest must be byte-identical to the JS writer's
// `Bun.CryptoHasher('sha1')` so the live server and the static build emit the
// SAME canonical URL. Standard SHA-1 satisfies that by construction.

public enum Sha1 {
    /// Lowercase 40-char hex SHA-1 of the UTF-8 bytes of `string`.
    /// Matches `new Bun.CryptoHasher('sha1').update(string).digest('hex')`.
    public static func hexString(_ string: String) -> String {
        hex(digest(Array(string.utf8)))
    }

    /// Raw 20-byte SHA-1 digest of `message`.
    public static func digest(_ message: [UInt8]) -> [UInt8] {
        var h0: UInt32 = 0x6745_2301
        var h1: UInt32 = 0xEFCD_AB89
        var h2: UInt32 = 0x98BA_DCFE
        var h3: UInt32 = 0x1032_5476
        var h4: UInt32 = 0xC3D2_E1F0

        // Pre-process: append 0x80, zero-pad to 56 mod 64, then the 64-bit
        // big-endian message length in bits.
        var msg = message
        let bitLen = UInt64(message.count) &* 8
        msg.append(0x80)
        while msg.count % 64 != 56 { msg.append(0) }
        for shift in stride(from: 56, through: 0, by: -8) {
            msg.append(UInt8((bitLen >> UInt64(shift)) & 0xFF))
        }

        var w = [UInt32](repeating: 0, count: 80)
        var chunk = 0
        while chunk < msg.count {
            for i in 0 ..< 16 {
                let j = chunk + i * 4
                w[i] =
                    (UInt32(msg[j]) << 24) | (UInt32(msg[j + 1]) << 16)
                    | (UInt32(msg[j + 2]) << 8) | UInt32(msg[j + 3])
            }
            for i in 16 ..< 80 {
                w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
            }

            var a = h0
            var b = h1
            var c = h2
            var d = h3
            var e = h4
            for i in 0 ..< 80 {
                let f: UInt32
                let k: UInt32
                switch i {
                    case 0 ..< 20:
                        f = (b & c) | (~b & d)
                        k = 0x5A82_7999
                    case 20 ..< 40:
                        f = b ^ c ^ d
                        k = 0x6ED9_EBA1
                    case 40 ..< 60:
                        f = (b & c) | (b & d) | (c & d)
                        k = 0x8F1B_BCDC
                    default:
                        f = b ^ c ^ d
                        k = 0xCA62_C1D6
                }
                let temp = rotl(a, 5) &+ f &+ e &+ k &+ w[i]
                e = d
                d = c
                c = rotl(b, 30)
                b = a
                a = temp
            }

            h0 = h0 &+ a
            h1 = h1 &+ b
            h2 = h2 &+ c
            h3 = h3 &+ d
            h4 = h4 &+ e
            chunk += 64
        }

        var out: [UInt8] = []
        out.reserveCapacity(20)
        for h in [h0, h1, h2, h3, h4] {
            out.append(UInt8((h >> 24) & 0xFF))
            out.append(UInt8((h >> 16) & 0xFF))
            out.append(UInt8((h >> 8) & 0xFF))
            out.append(UInt8(h & 0xFF))
        }
        return out
    }

    /// Lowercase hex encoding of `bytes`.
    public static func hex(_ bytes: [UInt8]) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var chars: [UInt8] = []
        chars.reserveCapacity(bytes.count * 2)
        for b in bytes {
            chars.append(digits[Int(b >> 4)])
            chars.append(digits[Int(b & 0x0F)])
        }
        return String(decoding: chars, as: UTF8.self)
    }

    @inline(__always)
    private static func rotl(_ x: UInt32, _ n: UInt32) -> UInt32 {
        (x << n) | (x >> (32 - n))
    }
}
