// ECMA-262 String.prototype.toLowerCase mirror: Unicode Default Case
// Conversion — per-scalar full lowercase mappings plus the single
// locale-independent context rule, Final_Sigma.
//
// Swift's String.lowercased() does NOT apply Final_Sigma (probed on 6.3.2:
// "ΟΔΟΣ" → "οδοσ" where JS yields "οδος"), so Σ is handled explicitly with
// the stdlib's Cased/Case_Ignorable properties.

enum CaseFolding {
  private static let sigma: UInt32 = 0x3A3
  private static let smallSigma = Unicode.Scalar(0x3C3)!
  private static let finalSmallSigma = Unicode.Scalar(0x3C2)!

  static func lowercase(_ scalars: [Unicode.Scalar]) -> [Unicode.Scalar] {
    var out: [Unicode.Scalar] = []
    out.reserveCapacity(scalars.count)
    for (i, s) in scalars.enumerated() {
      if s.value < 0x80 {
        out.append(s.value >= 0x41 && s.value <= 0x5A ? Unicode.Scalar(s.value + 32)! : s)
      } else if s.value == sigma {
        out.append(isFinalSigma(scalars, at: i) ? finalSmallSigma : smallSigma)
      } else {
        // Full mapping (İ → i + U+0307, ẞ → ß, …); identity when uncased.
        out.append(contentsOf: s.properties.lowercaseMapping.unicodeScalars)
      }
    }
    return out
  }

  /// Final_Sigma (Unicode Default Case Algorithms, table 3-17):
  /// before C: cased (case-ignorable)* — after C: not ((case-ignorable)* cased).
  static func isFinalSigma(_ scalars: [Unicode.Scalar], at index: Int) -> Bool {
    var i = index - 1
    var precededByCased = false
    while i >= 0 {
      let p = scalars[i].properties
      if p.isCaseIgnorable {
        i -= 1
        continue
      }
      precededByCased = p.isCased
      break
    }
    guard precededByCased else { return false }
    var j = index + 1
    while j < scalars.count {
      let p = scalars[j].properties
      if p.isCaseIgnorable {
        j += 1
        continue
      }
      return !p.isCased
    }
    return true
  }
}
