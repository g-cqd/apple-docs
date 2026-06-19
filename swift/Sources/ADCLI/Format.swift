// TTY-aware ANSI styling + the two human formatters, ported byte-for-byte from
// the Bun CLI (src/cli/formatters/listings.js + src/cli/_shared.js). ANSI is
// emitted ONLY when stdout is a TTY; piped (the parity harness) gets the plain
// branch. Strings are built with the JS join semantics — no trailing newline
// here; the caller's `print` adds exactly one `\n` (matching `console.log`).

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

import ADStorage

/// stdout is a terminal (fd 1). Mirrors JS `process.stdout.isTTY`.
let stdoutIsTTY: Bool = isatty(1) != 0

/// `bold(s)` — `\x1b[1m…\x1b[0m` on a TTY, identity otherwise.
func bold(_ string: String) -> String {
    stdoutIsTTY ? "\u{1B}[1m\(string)\u{1B}[0m" : string
}

/// `dim(s)` — `\x1b[2m…\x1b[0m` on a TTY, identity otherwise.
func dim(_ string: String) -> String {
    stdoutIsTTY ? "\u{1B}[2m\(string)\u{1B}[0m" : string
}

// MARK: - frameworks

/// Port of JS `formatFrameworks`. Groups roots by `kind` in FIRST-SEEN order
/// (roots arrive slug-ordered from the query), two leading spaces before each
/// name, a blank line after each group, then the `<total> total roots` footer.
func formatFrameworks(_ roots: [FrameworkRoot]) -> String {
    if roots.isEmpty { return "No frameworks found. Run `apple-docs sync` first." }

    var lines: [String] = []
    // Ordered grouping: encounter-ordered keys + a value bucket per key, to match
    // JS object insertion order under `Object.entries`.
    var order: [String] = []
    var byKind: [String: [FrameworkRoot]] = [:]
    for root in roots {
        // JS uses `r.kind ?? 'unknown'`; the storage API pre-coalesces a NULL
        // column to "", so an empty kind maps to "unknown" here for parity.
        let key = root.kind.isEmpty ? "unknown" : root.kind
        if byKind[key] == nil {
            byKind[key] = []
            order.append(key)
        }
        byKind[key]?.append(root)
    }

    for kind in order {
        let group = byKind[kind] ?? []
        lines.append(bold("\(kind) (\(group.count))"))
        for root in group {
            let count = root.pageCount > 0 ? dim(" (\(root.pageCount) pages)") : ""
            lines.append("  \(root.name)\(count)")
        }
        lines.append("")
    }
    lines.append("\(roots.count) total roots")
    return lines.joined(separator: "\n")
}

// MARK: - kinds (taxonomy)

/// A taxonomy section: the field label + its rows. Mirrors the `[label, values]`
/// pairs the JS formatter iterates (targeted: one section; broad: five).
struct TaxonomySection {
    let label: String
    let values: [TaxonomyCount]
}

/// Port of JS `formatTaxonomy`. `  <value> (<count>)` per row (two leading
/// spaces, dim-wrapped count), a blank line after each non-empty section, then
/// the whole joined string is `.trimEnd()`-ed (trailing whitespace removed).
func formatTaxonomy(_ sections: [TaxonomySection]) -> String {
    var lines: [String] = []
    for section in sections {
        if section.values.isEmpty { continue }
        lines.append(bold("\(section.label) (\(section.values.count))"))
        for row in section.values {
            lines.append("  \(row.value) \(dim("(\(row.count))"))")
        }
        lines.append("")
    }
    return trimEnd(lines.joined(separator: "\n"))
}

/// JS `String.prototype.trimEnd()` — strip trailing whitespace. Realistic
/// content is ASCII; this strips ASCII whitespace (space, tab, newline, CR,
/// form feed, vertical tab), which covers the trailing blank-line(s) the
/// formatter appends.
private func trimEnd(_ string: String) -> String {
    var scalars = Array(string.unicodeScalars)
    while let last = scalars.last, isASCIIWhitespace(last) {
        scalars.removeLast()
    }
    var result = ""
    result.unicodeScalars.append(contentsOf: scalars)
    return result
}

/// ASCII whitespace per JS `\s` for the trimming helpers (space, \t, \n, \v, \f, \r).
func isASCIIWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar {
    case " ", "\t", "\n", "\u{0B}", "\u{0C}", "\r": return true
    default: return false
    }
}
