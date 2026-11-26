import AppleDocsCore

/// JavaScript `\s` helpers (shared with ``DocumentPlainText``).
enum JSWhitespace {
    static func contains(_ scalar: Unicode.Scalar) -> Bool { DocumentPlainText.isJSWhitespace(scalar) }

    /// `String.prototype.trim()`.
    static func trim(_ text: String) -> String { DocumentPlainText.trim(text) }
}
