// Small stdlib-only string helpers (no Foundation — keep ad-server's runtime
// lean). `trimWS` mirrors JS `.trim()` for the ASCII whitespace real queries
// use; `lowered` is JS `.toLowerCase()` for the ASCII identifiers we compare.

func trimWS(_ s: String) -> String {
    var sub = Substring(s)
    while let f = sub.first, f.isWhitespace { sub = sub.dropFirst() }
    while let l = sub.last, l.isWhitespace { sub = sub.dropLast() }
    return String(sub)
}

/// Doubles every `"` (FTS5 phrase escaping), no Foundation.
func escapeFtsQuotes(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.count + 2)
    for ch in s {
        out.append(ch)
        if ch == "\"" { out.append(ch) }
    }
    return out
}
