// UTF-8-byte-keyed vocabulary. Swift's String hashing conflates canonically
// equivalent keys (probed: ["e\u{301}": 1]["\u{e9}"] hits), while JS Maps key
// on exact code units — and the potion vocab stores NFD-form Korean entries,
// so a String-keyed dictionary would corrupt lookups. Bytes are exact.

struct Vocab {
  struct Key: Hashable {
    let bytes: [UInt8]
  }

  private let ids: [Key: Int32]

  /// `tokens` is the id-ordered array (fixture vocab.json shape); the
  /// generator guarantees byte-distinctness.
  init(tokens: [String]) {
    var map = [Key: Int32](minimumCapacity: tokens.count * 2)
    for (id, token) in tokens.enumerated() {
      map[Key(bytes: Array(token.utf8))] = Int32(id)
    }
    ids = map
  }

  func id(of bytes: [UInt8]) -> Int32? {
    ids[Key(bytes: bytes)]
  }

  var count: Int { ids.count }
}
