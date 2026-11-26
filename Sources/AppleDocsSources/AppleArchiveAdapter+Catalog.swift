import AemiJSONCore
import AppleDocsCore
import Foundation
import OrderedCollections

extension AppleArchiveAdapter {
    static func parseCatalog(body: [UInt8]) throws(SourceError) -> [String: GuideEntry] {
        let sanitized = sanitizeLibraryJS(String(decoding: body, as: UTF8.self))
        let doc: JSONDocument
        do {
            doc = try AemiJSON.parse(Array(sanitized.utf8))
        } catch {
            throw .malformedPayload(url: libraryURL, reason: "Archive library.json parse error: \(error)")
        }
        let root = doc.root
        let cols = root["columns"]
        let nameIdx = cols["name"].int ?? 0
        let typeIdx = cols["type"].int ?? 2
        let platformIdx = cols["platform"].int ?? 3
        let urlIdx = cols["url"].int ?? 9

        var map: [String: GuideEntry] = [:]
        for item in root["documents"].array ?? [] {
            guard let row = item.array, typeIdx < row.count, urlIdx < row.count else { continue }
            let typeText = row[typeIdx].string ?? row[typeIdx].int.map(String.init) ?? ""
            guard typeText == "3" else { continue }
            let rawRel = row[urlIdx].string ?? ""
            let rel = normalizeRelativeURL(rawRel)
            guard rel.hasPrefix("documentation/") || rel.hasPrefix("featuredarticles/") else { continue }
            let format = archiveFormat(rel)
            guard ["html", "htm", "pdf"].contains(format), !knownMissingPaths.contains(rel) else { continue }
            let rawKey = pathToKey(rel)
            guard let key = try? DocumentKey(rawKey), map[key.rawValue] == nil else { continue }
            let title =
                nameIdx < row.count
                ? AdapterHelpers.decodeBasicHTMLEntities(row[nameIdx].string ?? key.rawValue) : key.rawValue
            let platform =
                platformIdx < row.count
                ? AdapterHelpers.decodeBasicHTMLEntities(row[platformIdx].string ?? "") : ""
            let meta = JSONValue.makeObject {
                ("resourceType", .string("Guides"))
                ("platform", platform.isEmpty ? .null : .string(platform))
                ("archivePath", .string(rel))
                ("format", .string(format))
            }
            map[key.rawValue] = GuideEntry(
                key: key,
                title: title,
                url: "\(archiveBase)/\(rel)",
                format: format,
                sourceMetadataJSON: JSONValue.jsonString(meta)
            )
        }
        return map
    }

    static func sanitizeLibraryJS(_ raw: String) -> String {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("("), text.hasSuffix(")"), text.count >= 2 {
            text = String(text.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return rewriteJSTokens(Array(text))
    }

    private static func rewriteJSTokens(_ chars: [Character]) -> String {
        var out: [Character] = []
        out.reserveCapacity(chars.count + 256)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if ch == "\"" {
                i = copyStringLiteral(chars, from: i, into: &out)
            } else if ch == ",", isBeforeClosingBracket(chars, after: i) {
                i += 1
            } else if ch == "{" || ch == "," {
                out.append(ch)
                i = copyOptionalUnquotedKey(chars, from: i + 1, into: &out)
            } else {
                out.append(ch)
                i += 1
            }
        }
        return String(out)
    }

    private static func copyStringLiteral(_ chars: [Character], from start: Int, into out: inout [Character]) -> Int {
        out.append("\"")
        var i = start + 1
        var escape = false
        while i < chars.count {
            let ch = chars[i]
            out.append(ch)
            i += 1
            if escape {
                escape = false
            } else if ch == "\\" {
                escape = true
            } else if ch == "\"" {
                break
            }
        }
        return i
    }

    private static func isBeforeClosingBracket(_ chars: [Character], after index: Int) -> Bool {
        var j = index + 1
        while j < chars.count, chars[j].isWhitespace { j += 1 }
        return j < chars.count && (chars[j] == "}" || chars[j] == "]")
    }

    private static func copyOptionalUnquotedKey(
        _ chars: [Character],
        from start: Int,
        into out: inout [Character]
    ) -> Int {
        var i = start
        while i < chars.count, chars[i].isWhitespace {
            out.append(chars[i])
            i += 1
        }
        guard i < chars.count, isJSIdentifierStart(chars[i]) else { return i }
        var end = i
        while end < chars.count, isJSIdentifierContinue(chars[end]) { end += 1 }
        var colon = end
        while colon < chars.count, chars[colon].isWhitespace { colon += 1 }
        let ident = String(chars[i ..< end])
        guard colon < chars.count, chars[colon] == ":", ident != "true", ident != "false", ident != "null" else {
            return i
        }
        out.append("\"")
        out.append(contentsOf: ident)
        out.append("\"")
        return end
    }

    private static func isJSIdentifierStart(_ ch: Character) -> Bool {
        ch.isLetter || ch == "_" || ch == "$"
    }

    private static func isJSIdentifierContinue(_ ch: Character) -> Bool {
        ch.isLetter || ch.isNumber || ch == "_" || ch == "$"
    }

    static func normalizeRelativeURL(_ raw: String) -> String {
        var text = raw
        if text.hasPrefix("../") { text = String(text.dropFirst(3)) }
        if let hash = text.firstIndex(of: "#") { text = String(text[..<hash]) }
        return text
    }

    static func archiveFormat(_ rel: String) -> String {
        guard let dot = rel.lastIndex(of: ".") else { return "html" }
        return rel[rel.index(after: dot)...].lowercased()
    }

    static func pathToKey(_ guidePath: String) -> String {
        let lower = guidePath.lowercased()
        for ext in [".html", ".htm"] where lower.hasSuffix(ext) {
            let withoutExt = String(guidePath.dropLast(ext.count))
            if let slash = withoutExt.lastIndex(of: "/") {
                let dir = String(withoutExt[..<slash])
                let fileBase = String(withoutExt[withoutExt.index(after: slash)...]).lowercased()
                let parent = dir.split(separator: "/").last.map { $0.lowercased() } ?? ""
                if fileBase == "index" || fileBase == parent {
                    return "\(rootSlug)/\(dir)"
                }
            }
        }
        return "\(rootSlug)/\(guidePath)"
    }

    static func fallbackURL(for key: DocumentKey) throws(SourceError) -> String {
        let rest = try AdapterHelpers.stripRootPrefix(rootSlug, from: key)
        if rest.hasSuffix(".html") || rest.hasSuffix(".htm") || rest.hasSuffix(".pdf") {
            return "\(archiveBase)/\(rest)"
        }
        return "\(archiveBase)/\(rest)/index.html"
    }

    static func deriveFramework(_ key: DocumentKey) -> String? {
        let parts = key.rawValue.split(separator: "/")
        return parts.count > 2 ? String(parts[2]).lowercased() : nil
    }
}
