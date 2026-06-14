// Progressive-relaxation helpers (RFC 0001 P6, R1-R3) — byte-exact port of
// src/search/relaxation.js. ASCII-centric by construction: JS `\w` is ASCII and
// the CamelCase test is `[a-z][A-Z]`, so tokens (split on non-[\w.]) are ASCII.

public import ADContent

enum Relaxation {
  static let stopwords: Set<String> = [
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "does", "for", "from", "get",
    "have", "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "of", "on", "or",
    "should", "that", "the", "their", "then", "there", "these", "this", "to", "use", "using",
    "want", "was", "way", "we", "were", "what", "when", "where", "which", "while", "why", "will",
    "with", "you", "your",
  ]

  /// JS `query.split(/[^\w.]+/)` then drop empty + single-ASCII-digit tokens.
  static func tokenize(_ query: String) -> [String] {
    var tokens: [String] = []
    var current = String.UnicodeScalarView()
    func flush() {
      guard !current.isEmpty else { return }
      let token = String(current)
      current = String.UnicodeScalarView()
      if token.unicodeScalars.count == 1, isDigit(token.unicodeScalars.first!) { return }
      tokens.append(token)
    }
    for s in query.unicodeScalars {
      if isWordOrDot(s) { current.append(s) } else { flush() }
    }
    flush()
    return tokens
  }

  /// Keep CamelCase tokens; otherwise drop stopwords (by `toLowerCase`).
  static func pruneStopwords(_ tokens: [String]) -> [String] {
    tokens.filter { isCamelCase($0) || !stopwords.contains(JsString.lowercase($0)) }
  }

  /// First CamelCase token; else the longest token of length >= 4 (UTF-16).
  static func pickHighSignalToken(_ tokens: [String]) -> String? {
    if let camel = tokens.first(where: isCamelCase) { return camel }
    var best: String?
    for token in tokens where token.utf16.count >= 4 {
      if best == nil || token.utf16.count > best!.utf16.count { best = token }
    }
    return best
  }

  /// `/[a-z][A-Z]/` — an ASCII lowercase immediately followed by an uppercase.
  static func isCamelCase(_ s: String) -> Bool {
    let scalars = Array(s.unicodeScalars)
    guard scalars.count >= 2 else { return false }
    for i in 1..<scalars.count where isAsciiLower(scalars[i - 1]) && isAsciiUpper(scalars[i]) {
      return true
    }
    return false
  }

  private static func isWordOrDot(_ s: Unicode.Scalar) -> Bool {
    isDigit(s) || isAsciiUpper(s) || isAsciiLower(s) || s == "_" || s == "."
  }
  private static func isDigit(_ s: Unicode.Scalar) -> Bool { s.value >= 48 && s.value <= 57 }
  private static func isAsciiLower(_ s: Unicode.Scalar) -> Bool { s.value >= 97 && s.value <= 122 }
  private static func isAsciiUpper(_ s: Unicode.Scalar) -> Bool { s.value >= 65 && s.value <= 90 }
}
