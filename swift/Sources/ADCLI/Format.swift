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

// MARK: - browse

/// JS template-literal coercion of an optional string: `${x}` renders a null as
/// the literal text `"null"`. Used where the JS formatter interpolates a
/// possibly-null value directly (e.g. `bold(result.title)` with a null title)
/// rather than via `?? path`.
private func jsString(_ value: String?) -> String {
    value ?? "null"
}

/// The three browse result shapes (one is produced per invocation). Mirrors the
/// JS result object whose present keys select the formatter branch.
enum BrowseResult {
    /// `--path` variant: the page's children grouped by section.
    case children(framework: String, path: String, title: String?, children: [BrowseChildEntry])
    /// wwdc default variant: session counts per year.
    case groups(framework: String, slug: String, kind: String, groups: [BrowseGroupEntry], total: Int)
    /// default / wwdc+year / wwdc+limit variant: a page listing.
    case pages(
        framework: String, slug: String, kind: String, year: Int?, pages: [BrowsePageEntry], total: Int,
        limited: Bool)
}

/// A child row of the `--path` variant (`{ path, title, section }`).
struct BrowseChildEntry {
    let path: String
    let title: String?
    let section: String?
}

/// A year bucket of the wwdc groups variant (`{ year, count }`).
struct BrowseGroupEntry {
    let year: Int
    let count: Int
}

/// A page row of the listing variant (`{ path, title, kind, abstract }`).
struct BrowsePageEntry {
    let path: String
    let title: String?
    let kind: String?
    let abstract: String?
}

/// Port of JS `formatBrowse`. Each branch's header element carries a literal
/// trailing `\n` (so `join('\n')` yields a blank line after it). No trailing
/// trim — the joined string is returned as-is to match the oracle byte-for-byte.
func formatBrowse(_ result: BrowseResult) -> String {
    switch result {
    case let .children(_, path, title, children):
        // `bold(result.title)` with a null title → JS interpolates "null".
        var lines = ["\(bold(jsString(title))) \(dim(path))\n"]
        // Group by `section ?? 'other'` in first-seen order (Object.entries order).
        var order: [String] = []
        var bySection: [String: [BrowseChildEntry]] = [:]
        for child in children {
            let key = child.section ?? "other"
            if bySection[key] == nil {
                bySection[key] = []
                order.append(key)
            }
            bySection[key]?.append(child)
        }
        for section in order {
            lines.append(bold(section))
            for child in bySection[section] ?? [] {
                lines.append("  \(child.title ?? child.path)")
            }
            lines.append("")
        }
        return lines.joined(separator: "\n")

    case let .groups(framework, slug, kind, groups, total):
        var lines = ["\(bold(framework)) \(dim("(\(slug), \(kind))"))\n"]
        for group in groups {
            // TWO spaces between the bold year and the dim count.
            lines.append("  \(bold(String(group.year)))  \(dim("\(group.count) sessions"))")
        }
        lines.append("\n\(total) sessions across \(groups.count) years")
        lines.append(dim("Use `browse \(slug) --year <year>` to list one year."))
        return lines.joined(separator: "\n")

    case let .pages(framework, slug, kind, year, pages, total, _):
        // `result.year ? (slug, year) : (slug, kind)` — WWDC years are 4-digit so truthy.
        let scope = year != nil ? "\(slug), \(year!)" : "\(slug), \(kind)"
        var lines = ["\(bold(framework)) \(dim("(\(scope))"))\n"]
        for page in pages.prefix(50) {
            let kindSuffix = page.kind.map { dim(" [\($0)]") } ?? ""
            lines.append("  \(page.title ?? page.path)\(kindSuffix)")
        }
        if total > 50 {
            lines.append(dim("  ... and \(total - 50) more"))
        }
        lines.append("\n\(total) pages")
        return lines.joined(separator: "\n")
    }
}
