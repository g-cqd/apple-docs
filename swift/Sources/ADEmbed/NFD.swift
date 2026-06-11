// Canonical decomposition mirroring String.normalize("NFD") in the engine
// that generated the tables. Swift 6.3 exposes no public NFD API, so the
// decomposition mappings are table-driven (recursively pre-expanded by the
// generator) plus the UAX #15 Hangul arithmetic.
//
// Combining classes come from the Swift stdlib — the one input here that is
// not engine-derived (ccc is not observable from JavaScript). ccc values are
// stable by Unicode policy for assigned scalars; the parity fixtures cover
// multi-mark reordering in both source orders to keep this honest.

enum NFD {
  static func decompose(_ scalars: [Unicode.Scalar]) -> [Unicode.Scalar] {
    var out: [Unicode.Scalar] = []
    out.reserveCapacity(scalars.count + scalars.count / 4)
    for s in scalars {
      appendDecomposition(of: s, to: &out)
    }
    canonicalReorder(&out)
    return out
  }

  private static func appendDecomposition(of s: Unicode.Scalar, to out: inout [Unicode.Scalar]) {
    let v = s.value
    if v < 0xC0 {
      // Below U+00C0 nothing decomposes (lowest table entry is À) — skip
      // the binary search for the ASCII bulk of real corpora.
      out.append(s)
      return
    }
    if v >= 0xAC00, v <= 0xD7A3 {
      // Hangul syllable → L V [T] jamo.
      let sIndex = v - 0xAC00
      out.append(Unicode.Scalar(0x1100 + sIndex / 588)!)
      out.append(Unicode.Scalar(0x1161 + (sIndex % 588) / 28)!)
      let t = sIndex % 28
      if t > 0 { out.append(Unicode.Scalar(0x11A7 + t)!) }
      return
    }
    if let payload = UnicodeSets.nfdDecomposition(of: v) {
      // Payload scalars come from real engine output; always valid.
      for p in payload { out.append(Unicode.Scalar(p)!) }
      return
    }
    out.append(s)
  }

  /// Canonical Ordering Algorithm: stably move each nonzero-ccc scalar past
  /// any directly preceding higher-ccc scalars (equal classes keep order).
  static func canonicalReorder(_ scalars: inout [Unicode.Scalar]) {
    guard scalars.count > 1 else { return }
    for i in 1..<scalars.count {
      // Every nonzero-ccc scalar is ≥ U+0300 — skip the (comparatively
      // costly) stdlib property lookup for ASCII/Latin-1.
      guard scalars[i].value >= 0x300 else { continue }
      let ccc = combiningClass(scalars[i])
      guard ccc > 0 else { continue }
      var j = i
      while j > 0, combiningClass(scalars[j - 1]) > ccc {
        scalars.swapAt(j - 1, j)
        j -= 1
      }
    }
  }

  static func combiningClass(_ s: Unicode.Scalar) -> UInt8 {
    s.properties.canonicalCombiningClass.rawValue
  }
}
