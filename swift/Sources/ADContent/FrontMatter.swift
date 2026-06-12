// Port of src/lib/yaml.js toFrontMatter — flat YAML front matter with the
// exact quoting rules (normative JS until the phase-5 kill).

public enum FrontMatter {
  public enum Value {
    case scalar(String)
    case list([String])
  }

  /// Ordered fields; nil values are skipped (the `value == null` guard —
  /// compactObject upstream already drops them, this keeps the seam safe).
  public static func render(_ fields: [(key: String, value: Value?)]) -> String {
    var lines = ["---"]
    for (key, value) in fields {
      guard let value else { continue }
      switch value {
      case .scalar(let s):
        lines.append("\(key): \(quoteIfNeeded(s))")
      case .list(let items):
        lines.append("\(key): [\(items.map(quoteIfNeeded).joined(separator: ", "))]")
      }
    }
    lines.append("---")
    return lines.joined(separator: "\n")
  }

  static func quoteIfNeeded(_ s: String) -> String {
    if needsQuoting(s) {
      var escaped = ""
      for ch in s.unicodeScalars {
        if ch == "\\" { escaped += "\\\\" } else if ch == "\"" { escaped += "\\\"" } else { escaped.unicodeScalars.append(ch) }
      }
      return "\"\(escaped)\""
    }
    return s
  }

  private static func needsQuoting(_ s: String) -> Bool {
    if s.isEmpty || s == "true" || s == "false" || s == "null" { return true }
    // /^[\d.]+$/ — ASCII digits and dots only.
    var allDigitsDots = true
    for ch in s.unicodeScalars {
      if !((ch >= "0" && ch <= "9") || ch == ".") {
        allDigitsDots = false
        break
      }
    }
    if allDigitsDots { return true }
    // /[:{}[\],&*?|>!%#@`"']/ or a newline anywhere.
    let special: Set<Unicode.Scalar> = [
      ":", "{", "}", "[", "]", ",", "&", "*", "?", "|", ">", "!", "%", "#", "@", "`", "\"", "'", "\n",
    ]
    for ch in s.unicodeScalars where special.contains(ch) { return true }
    return false
  }
}
