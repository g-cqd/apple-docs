extension String {
    /// `self` with every occurrence of the Unicode scalar `target` replaced by `replacement`.
    ///
    /// Unlike `replacing(_:with:)`, which matches whole grapheme clusters, this sees a `"` even when a combining
    /// mark follows it — required for escaping into languages tokenized per code point (FTS5, SQL `LIKE`, YAML).
    public func replacingScalars(_ target: Unicode.Scalar, with replacement: String) -> String {
        replacingScalars([target: replacement])
    }

    /// `self` with each scalar found in `replacements` replaced by its value.
    public func replacingScalars(_ replacements: [Unicode.Scalar: String]) -> String {
        guard unicodeScalars.contains(where: { replacements[$0] != nil }) else { return self }
        var out = ""
        out.reserveCapacity(utf8.count + 8)
        for scalar in unicodeScalars {
            if let replacement = replacements[scalar] {
                out += replacement
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    /// Whether `self` contains the scalar `target` (regardless of grapheme clustering).
    public func containsScalar(_ target: Unicode.Scalar) -> Bool {
        unicodeScalars.contains(target)
    }
}
