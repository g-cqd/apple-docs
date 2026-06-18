// UTF-8-byte-keyed vocabulary. Swift's String hashing conflates canonically
// equivalent keys (probed: ["e\u{301}": 1]["\u{e9}"] hits), while JS Maps key
// on exact code units — and the potion vocab stores NFD-form Korean entries,
// so a String-keyed dictionary would corrupt lookups. Bytes are exact.
//
// Storage is a flat byte arena + FNV-1a open-addressing table so the
// WordPiece greedy loop can probe candidates as (prefix, slice) pairs with
// ZERO per-candidate allocation — the original Dictionary<[UInt8],Int32>
// version allocated a key array per candidate and dominated the embed
// profile.

struct Vocab {
    private let arena: [UInt8]
    private let tokenOffsets: [UInt32]  // count+1 prefix offsets into arena
    // Open-addressing table of (vocab index + 1); 0 = empty. Power-of-two.
    private let table: [UInt32]
    private let mask: UInt64
    let count: Int

    /// `tokens` is the id-ordered array (fixture vocab.json shape); the
    /// generator guarantees byte-distinctness.
    init(tokens: [String]) {
        count = tokens.count
        var arena: [UInt8] = []
        var offsets: [UInt32] = [0]
        offsets.reserveCapacity(tokens.count + 1)
        for token in tokens {
            arena.append(contentsOf: token.utf8)
            offsets.append(UInt32(arena.count))
        }
        self.arena = arena
        self.tokenOffsets = offsets

        var capacity = 16
        while capacity < tokens.count * 2 { capacity *= 2 }
        var table = [UInt32](repeating: 0, count: capacity)
        let mask = UInt64(capacity - 1)
        arena.withUnsafeBufferPointer { bytes in
            for index in 0 ..< tokens.count {
                let start = Int(offsets[index])
                let end = Int(offsets[index + 1])
                var hash = Self.fnvOffset
                for i in start ..< end { hash = (hash ^ UInt64(bytes[i])) &* Self.fnvPrime }
                var slot = Int(hash & mask)
                while table[slot] != 0 { slot = (slot + 1) & Int(mask) }
                table[slot] = UInt32(index + 1)
            }
        }
        self.table = table
        self.mask = mask
    }

    private static let fnvOffset: UInt64 = 0xCBF2_9CE4_8422_2325
    private static let fnvPrime: UInt64 = 0x1_0000_01B3

    func id(of bytes: [UInt8]) -> Int32? {
        bytes.withUnsafeBufferPointer { id(prefix: UnsafeBufferPointer(start: nil, count: 0), body: $0) }
    }

    /// Lookup of the logical key `prefix ++ body` without materializing it —
    /// FNV runs sequentially across both parts; equality compares both parts.
    func id(prefix: UnsafeBufferPointer<UInt8>, body: UnsafeBufferPointer<UInt8>) -> Int32? {
        var hash = Self.fnvOffset
        for i in 0 ..< prefix.count { hash = (hash ^ UInt64(prefix[i])) &* Self.fnvPrime }
        for i in 0 ..< body.count { hash = (hash ^ UInt64(body[i])) &* Self.fnvPrime }
        let keyLength = prefix.count + body.count

        return arena.withUnsafeBufferPointer { bytes -> Int32? in
            var slot = Int(hash & mask)
            while true {
                let stored = table[slot]
                if stored == 0 { return nil }
                let index = Int(stored - 1)
                let start = Int(tokenOffsets[index])
                let end = Int(tokenOffsets[index + 1])
                if end - start == keyLength {
                    var matches = true
                    for i in 0 ..< prefix.count where bytes[start + i] != prefix[i] {
                        matches = false
                        break
                    }
                    if matches {
                        for i in 0 ..< body.count where bytes[start + prefix.count + i] != body[i] {
                            matches = false
                            break
                        }
                    }
                    if matches { return Int32(index) }
                }
                slot = (slot + 1) & Int(mask)
            }
        }
    }
}
