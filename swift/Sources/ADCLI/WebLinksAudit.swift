// S9 — the build-time link audit (src/commands/links.js `linksAudit`): walk
// every rendered /docs HTML file, extract each `<a href>` with its
// section attribution, classify through ADBuilder's LinkResolver.classify
// (the classifyLink port), and aggregate the same stats object build.js step
// 11 logs. The known-key universe is every non-deleted page path PLUS its
// hashed web alias (safeWebDocKey).
//
// Determinism note: the JS walk is readdir order (unsorted); this port walks
// with POSIX readdir the same way, and the top-N lists replicate JS's STABLE
// count-desc sort with an insertion-index tiebreak.

import ADBase
import ADBuilder
import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

struct LinksAuditResult {
    var filesScanned = 0
    var linksTotal = 0
    var bySection: [(String, Int)] = []
    var byCategory: [(String, Int)] = []
    var byCategoryAndSection: [(String, Int)] = []
    var topBrokenInternal: [(value: String, count: Int, sources: [String])] = []
    var topRelativeBroken: [(value: String, count: Int, sources: [String])] = []
    var topExternalResolvable: [(value: String, count: Int, sources: [String])] = []
}

enum WebLinksAudit {
    /// Port of `linksAudit({outDir}, {db})`. Throws when outDir (or its /docs)
    /// is missing, like the JS NotFoundError paths.
    static func run(outDir: String, connection: StorageConnection) throws -> LinksAuditResult {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: outDir) else {
            throw ValidationError("outDir does not exist: \(outDir). Run `apple-docs web build` first.")
        }
        let docsRoot = "\(outDir)/docs"
        guard fileManager.fileExists(atPath: docsRoot) else {
            throw ValidationError("No /docs directory in \(outDir); the build may have failed.")
        }

        // knownKeys: active page paths + hashed web aliases.
        var knownKeys = Set<String>()
        for path in connection.auditPageKeys() {
            knownKeys.insert(path)
            let webKey = SafePath.safeWebDocKey(path)
            if webKey != path { knownKeys.insert(webKey) }
        }

        var result = LinksAuditResult()
        var bySection = CountMap()
        var byCategory = CountMap()
        var byCategoryAndSection = CountMap()
        var broken = TopMap()
        var relative = TopMap()
        var resolvable = TopMap()

        for file in walkFiles(docsRoot) where file.hasSuffix(".html") {
            result.filesScanned += 1
            guard let html = try? String(contentsOfFile: file, encoding: .utf8) else { continue }
            // `file.slice(outDir.length).replace(/\/index\.html$/, '/')`.
            var fromPath = String(file.dropFirst(outDir.count))
            if fromPath.hasSuffix("/index.html") { fromPath = String(fromPath.dropLast(10)) }

            for link in extractLinks(html) {
                result.linksTotal += 1
                bySection.bump(link.section)
                let classified = LinkResolver.classify(link.href, knownKeys: knownKeys)
                let category = categoryName(classified)
                byCategory.bump(category)
                byCategoryAndSection.bump("\(category)/\(link.section)")

                switch classified {
                case .internalBroken(let key):
                    broken.record(key, source: fromPath)
                case .relativeBroken:
                    relative.record(link.href, source: fromPath)
                case .externalResolvable(let key, _):
                    resolvable.record(key, source: fromPath)
                default:
                    break
                }
            }
        }

        result.bySection = bySection.pairs
        result.byCategory = byCategory.pairs
        result.byCategoryAndSection = byCategoryAndSection.pairs
        result.topBrokenInternal = broken.finalized()
        result.topRelativeBroken = relative.finalized()
        result.topExternalResolvable = resolvable.finalized()
        return result
    }

    /// The audit result as the JS return object (JSON.stringify-ordered).
    static func json(_ result: LinksAuditResult) -> JSONValue {
        func counts(_ pairs: [(String, Int)]) -> JSONValue {
            .obj(pairs.map { ($0.0, .int(Int64($0.1))) })
        }
        func top(_ list: [(value: String, count: Int, sources: [String])]) -> JSONValue {
            .array(
                list.map { entry in
                    .obj([
                        ("value", .string(entry.value)),
                        ("count", .int(Int64(entry.count))),
                        ("sources", .array(entry.sources.map(JSONValue.string))),
                    ])
                })
        }
        return .obj([
            ("filesScanned", .int(Int64(result.filesScanned))),
            ("linksTotal", .int(Int64(result.linksTotal))),
            ("bySection", counts(result.bySection)),
            ("byCategory", counts(result.byCategory)),
            ("byCategoryAndSection", counts(result.byCategoryAndSection)),
            ("topBrokenInternal", top(result.topBrokenInternal)),
            ("topRelativeBroken", top(result.topRelativeBroken)),
            ("topExternalResolvable", top(result.topExternalResolvable)),
        ])
    }

    /// The build summary line (the cli.js web-build formatter's `Links:` row).
    static func summary(_ result: LinksAuditResult) -> String {
        func count(_ name: String) -> Int {
            result.byCategory.first { $0.0 == name }?.1 ?? 0
        }
        return "Links: \(result.linksTotal) total · \(count("internal_ok")) ok, "
            + "\(count("internal_broken")) broken, \(count("external_resolvable")) external_resolvable, "
            + "\(count("relative_broken")) relative_broken"
    }

    private static func categoryName(_ classified: LinkResolver.LinkClass) -> String {
        switch classified {
        case .fragment: return "fragment"
        case .internalOk: return "internal_ok"
        case .internalBroken: return "internal_broken"
        case .externalResolvable: return "external_resolvable"
        case .external: return "external"
        case .relativeBroken: return "relative_broken"
        }
    }

    // MARK: - HTML link extraction (extractLinks port)

    struct ExtractedLink {
        let href: String
        let section: String
    }

    /// Port of `extractLinks(html)`: HREF_REGEX matches over the whole
    /// document; each match is attributed to the LAST
    /// article/nav/aside/header/footer open tag whose [start, nextStart)
    /// region contains it, labeled per `labelFor`.
    static func extractLinks(_ html: String) -> [ExtractedLink] {
        let scalars = Array(html.unicodeScalars)
        var regions: [(tag: String, cls: String, start: Int)] = []
        var anchors: [(href: String, index: Int)] = []

        var i = 0
        let n = scalars.count
        while i < n {
            guard scalars[i] == "<" else {
                i += 1
                continue
            }
            // Section opener?
            if let (tag, tagEnd) = matchSectionTag(scalars, at: i) {
                let cls = classAttribute(scalars, from: i, to: tagEnd)
                regions.append((tag: tag, cls: lowercased(cls), start: i))
                i += 1
                continue
            }
            // `<a\s[^>]*href\s*=\s*"([^"]+)"` — case-insensitive.
            if i + 2 < n, lowerScalar(scalars[i + 1]) == "a", isJsSpace(scalars[i + 2]) {
                var j = i + 3
                while j < n, scalars[j] != ">" {
                    if let (href, end) = matchHref(scalars, at: j), !href.isEmpty {
                        anchors.append((href: href, index: i))
                        j = end
                        break
                    }
                    j += 1
                }
                i = j
                continue
            }
            i += 1
        }

        // Stamp region ends as the NEXT region's start (the JS heuristic).
        var out: [ExtractedLink] = []
        out.reserveCapacity(anchors.count)
        for anchor in anchors {
            var label = "other"
            for r in stride(from: regions.count - 1, through: 0, by: -1) {
                let end = r + 1 < regions.count ? regions[r + 1].start : n
                if regions[r].start <= anchor.index && anchor.index < end {
                    label = labelFor(tag: regions[r].tag, cls: regions[r].cls)
                    break
                }
            }
            out.append(ExtractedLink(href: anchor.href, section: label))
        }
        return out
    }

    private static func labelFor(tag: String, cls: String) -> String {
        if cls.contains("breadcrumb") { return "breadcrumb" }
        if cls.contains("topics") || cls.contains("see-also") { return "related" }
        if cls.contains("symbols-detail") { return "sidebar" }
        switch tag {
        case "article": return "article"
        case "aside": return "sidebar"
        case "nav": return "breadcrumb"
        case "header", "footer": return "chrome"
        default: return tag
        }
    }

    /// `<(article|nav|aside|header|footer)\b` at position `i` (which holds `<`).
    /// Returns the tag + the index of the closing `>` (or n).
    private static func matchSectionTag(_ s: [Unicode.Scalar], at i: Int) -> (String, Int)? {
        for tag in ["article", "nav", "aside", "header", "footer"] {
            let chars = Array(tag.unicodeScalars)
            guard i + chars.count < s.count else { continue }
            var ok = true
            for (k, c) in chars.enumerated() where lowerScalar(s[i + 1 + k]) != c {
                ok = false
                break
            }
            guard ok else { continue }
            // \b: the next scalar must not be a word char.
            let next = i + 1 + chars.count
            if next < s.count, isWordScalar(s[next]) { continue }
            var end = next
            while end < s.count, s[end] != ">" { end += 1 }
            return (tag, end)
        }
        return nil
    }

    /// First `class\s*=\s*"([^"]*)"` inside [from, to).
    private static func classAttribute(_ s: [Unicode.Scalar], from: Int, to: Int) -> String {
        let needle = Array("class".unicodeScalars)
        var i = from
        while i + needle.count < to {
            var ok = true
            for (k, c) in needle.enumerated() where lowerScalar(s[i + k]) != c {
                ok = false
                break
            }
            if ok {
                var j = i + needle.count
                while j < to, isJsSpace(s[j]) { j += 1 }
                guard j < to, s[j] == "=" else {
                    i += 1
                    continue
                }
                j += 1
                while j < to, isJsSpace(s[j]) { j += 1 }
                guard j < to, s[j] == "\"" else {
                    i += 1
                    continue
                }
                j += 1
                var value = String.UnicodeScalarView()
                while j < to, s[j] != "\"" {
                    value.append(s[j])
                    j += 1
                }
                return String(value)
            }
            i += 1
        }
        return ""
    }

    /// `href\s*=\s*"([^"]+)"` at position `j`; returns (href, index-after-quote).
    private static func matchHref(_ s: [Unicode.Scalar], at j: Int) -> (String, Int)? {
        let needle = Array("href".unicodeScalars)
        guard j + needle.count < s.count else { return nil }
        for (k, c) in needle.enumerated() where lowerScalar(s[j + k]) != c { return nil }
        var i = j + needle.count
        while i < s.count, isJsSpace(s[i]) { i += 1 }
        guard i < s.count, s[i] == "=" else { return nil }
        i += 1
        while i < s.count, isJsSpace(s[i]) { i += 1 }
        guard i < s.count, s[i] == "\"" else { return nil }
        i += 1
        var value = String.UnicodeScalarView()
        while i < s.count, s[i] != "\"" {
            value.append(s[i])
            i += 1
        }
        guard i < s.count else { return nil }
        return (String(value), i + 1)
    }

    private static func lowerScalar(_ s: Unicode.Scalar) -> Unicode.Scalar {
        (s.value >= 65 && s.value <= 90) ? Unicode.Scalar(s.value + 32)! : s
    }
    private static func isWordScalar(_ s: Unicode.Scalar) -> Bool {
        (s.value >= 48 && s.value <= 57) || (s.value >= 65 && s.value <= 90)
            || (s.value >= 97 && s.value <= 122) || s == "_"
    }
    private static func isJsSpace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029,
            0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }
    private static func lowercased(_ s: String) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.map(lowerScalar)))
    }

    // MARK: - readdir-order file walk (walkFiles port)

    private static func walkFiles(_ root: String) -> [String] {
        var out: [String] = []
        guard let dir = opendir(root) else { return out }
        defer { closedir(dir) }
        var names: [(name: String, isDir: Bool)] = []
        while let entry = readdir(dir) {
            let name = withUnsafeBytes(of: entry.pointee.d_name) { raw -> String in
                let bytes = raw.bindMemory(to: UInt8.self)
                var length = 0
                while length < bytes.count && bytes[length] != 0 { length += 1 }
                return String(decoding: bytes[0..<length], as: UTF8.self)
            }
            if name == "." || name == ".." { continue }
            names.append((name: name, isDir: entry.pointee.d_type == 4))
        }
        for entry in names {
            let full = "\(root)/\(entry.name)"
            if entry.isDir {
                out.append(contentsOf: walkFiles(full))
            } else {
                out.append(full)
            }
        }
        return out
    }
}

/// Insertion-ordered counter (JS object property order).
private struct CountMap {
    private(set) var pairs: [(String, Int)] = []
    private var index: [String: Int] = [:]
    mutating func bump(_ key: String) {
        if let i = index[key] {
            pairs[i].1 += 1
        } else {
            index[key] = pairs.count
            pairs.append((key, 1))
        }
    }
}

/// The broken/relative/resolvable top-lists: count + first-5 unique sources,
/// finalized as the JS stable count-desc sort capped at 50.
private struct TopMap {
    private var order: [String] = []
    private var entries: [String: (count: Int, sources: [String])] = [:]
    mutating func record(_ key: String, source: String) {
        if var entry = entries[key] {
            entry.count += 1
            if entry.sources.count < 5, !entry.sources.contains(source) { entry.sources.append(source) }
            entries[key] = entry
        } else {
            order.append(key)
            entries[key] = (count: 1, sources: [source])
        }
    }
    func finalized() -> [(value: String, count: Int, sources: [String])] {
        let indexed = order.enumerated().map { (index: $0.offset, key: $0.element) }
        let sorted = indexed.sorted { a, b in
            let ca = entries[a.key]?.count ?? 0
            let cb = entries[b.key]?.count ?? 0
            if ca != cb { return ca > cb }
            return a.index < b.index  // JS stable sort tiebreak
        }
        return sorted.prefix(50).map { item in
            let entry = entries[item.key] ?? (count: 0, sources: [])
            return (value: item.key, count: entry.count, sources: entry.sources)
        }
    }
}
