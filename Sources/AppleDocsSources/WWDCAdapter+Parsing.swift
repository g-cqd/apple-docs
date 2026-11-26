import AemiHTML
import AemiJSONCore
import AppleDocsContent
import AppleDocsCore
import Foundation
import OrderedCollections

extension WWDCAdapter {
    static func parseYearIndex(html: [UInt8], year: Int) -> (sessionIDs: [String], tracks: [String: String]) {
        let doc = HTMLParser.parse(html)
        let needle = "/videos/play/wwdc\(year)/"
        var sessionIDs: [String] = []
        var seen: Set<String> = []
        var tracks: [String: String] = [:]
        for node in doc.descendants(of: doc.root) where doc.isElement(node, "a") {
            guard let hrefSlice = doc.attribute("href", of: node) else { continue }
            let href = String(decoding: hrefSlice, as: UTF8.self)
            guard let range = href.range(of: needle) else { continue }
            let digits = href[range.upperBound...].prefix { $0.isNumber }
            guard !digits.isEmpty else { continue }
            let id = String(digits)
            if seen.insert(id).inserted { sessionIDs.append(id) }
            if tracks[id] == nil {
                let topic = findTopicAttribute(doc: doc, root: node)
                if let topic, !topic.isEmpty { tracks[id] = topic }
            }
        }
        return (sessionIDs, tracks)
    }

    private static func findTopicAttribute(doc: HTMLDocument, root: HTMLDocument.Node) -> String? {
        let candidates = [root] + doc.descendants(of: root).filter { doc.kind($0) == .element }
        for node in candidates {
            if let attr = doc.attribute("data-filter-topics", of: node) {
                return AdapterHelpers.collapseWhitespace(String(decoding: attr, as: UTF8.self))
            }
        }
        return nil
    }

    static func normalizeAppleSession(
        key: DocumentKey,
        html: [UInt8],
        year: Int,
        sessionID: String,
        track: String?
    ) -> ConvertedDocument {
        let extracted = extractAppleSessionDOM(from: HTMLParser.parse(html))
        let resolvedTitle =
            (extracted.title?.isEmpty == false ? extracted.title : nil)
            ?? "WWDC\(year) Session \(sessionID)"
        let description = extracted.paragraphs.first { $0.count > 30 } ?? extracted.paragraphs.first
        let descIndex = description.flatMap { extracted.paragraphs.firstIndex(of: $0) } ?? -1
        let transcriptParagraphs =
            descIndex >= 0 ? extracted.paragraphs[(descIndex + 1)...].filter { $0.count > 15 } : []
        let transcript = transcriptParagraphs.isEmpty ? nil : transcriptParagraphs.joined(separator: "\n\n")
        let sections = buildAppleSections(
            description: description,
            chapters: extracted.chapters,
            transcript: transcript
        )

        var meta = OrderedDictionary<String, JSONValue>()
        meta["year"] = .int(Int64(year))
        meta["sessionId"] = .string(sessionID)
        meta["source"] = .string("apple")
        if let track, !track.isEmpty { meta["track"] = .string(track) }
        return makeSessionDocument(
            key: key,
            title: resolvedTitle,
            playURL: "\(applePlayBase)/wwdc\(year)/\(sessionID)/",
            abstractText: description,
            metadata: .object(meta),
            sections: sections
        )
    }

    private static func extractAppleSessionDOM(
        from doc: HTMLDocument
    ) -> (title: String?, paragraphs: [String], chapters: [String]) {
        var title: String?
        var paragraphs: [String] = []
        var chapters: [String] = []
        var seenH1 = false

        for node in doc.descendants(of: doc.root)
        where doc.kind(node) == .element && !isSkippedAncestor(doc: doc, node: node) {
            if !seenH1, doc.isElement(node, "h1") {
                title = plainText(doc: doc, root: node)
                seenH1 = true
            } else if doc.isElement(node, "h2"), plainText(doc: doc, root: node).lowercased() == "chapters" {
                chapters.append(contentsOf: extractChapterList(after: node, in: doc))
            } else if seenH1, doc.isElement(node, "p") {
                let text = plainText(doc: doc, root: node)
                if !text.isEmpty { paragraphs.append(text) }
            }
        }
        return (title, paragraphs, chapters)
    }

    private static func extractChapterList(after heading: HTMLDocument.Node, in doc: HTMLDocument) -> [String] {
        var sib = doc.nextSibling(heading)
        while !sib.isNone {
            if doc.kind(sib) == .element {
                guard doc.isElement(sib, "ul") else { return [] }
                return doc.descendants(of: sib)
                    .compactMap { li in
                        guard doc.isElement(li, "li") else { return nil }
                        let text = plainText(doc: doc, root: li)
                        return text.isEmpty ? nil : text
                    }
            }
            sib = doc.nextSibling(sib)
        }
        return []
    }

    private static func buildAppleSections(
        description: String?,
        chapters: [String],
        transcript: String?
    ) -> [DocumentSectionRecord] {
        var sections: [DocumentSectionRecord] = []
        func push(_ kind: String, heading: String?, text: String?) {
            guard let text, !text.isEmpty else { return }
            sections.append(
                DocumentSectionRecord(sectionKind: kind, heading: heading, contentText: text, sortOrder: sections.count)
            )
        }
        push("abstract", heading: nil, text: description)
        push("content", heading: "Chapters", text: chapters.isEmpty ? nil : chapters.joined(separator: "\n"))
        push("content", heading: "Transcript", text: transcript)
        return sections
    }

    private static func isSkippedAncestor(doc: HTMLDocument, node: HTMLDocument.Node) -> Bool {
        var cur = node
        while !cur.isNone {
            if AdapterHelpers.isAnyElement(doc, cur, ["script", "style", "noscript", "nav", "header", "footer"]) {
                return true
            }
            cur = doc.parent(cur)
        }
        return false
    }

    private static func plainText(doc: HTMLDocument, root: HTMLDocument.Node) -> String {
        var parts: [String] = []
        for node in doc.descendants(of: root) where doc.kind(node) == .text {
            let piece = AdapterHelpers.collapseWhitespace(String(decoding: doc.data(node), as: UTF8.self))
            if !piece.isEmpty { parts.append(piece) }
        }
        return parts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func normalizeAsciiSession(
        key: DocumentKey,
        rawText: String,
        year: Int,
        sessionID: String
    ) -> ConvertedDocument {
        let normalized = rawText.replacing("\r\n", with: "\n").replacing("\r", with: "\n")
        let title = extractAsciiTitle(normalized, year: year, sessionID: sessionID)
        var cleaned: [String] = []
        for rawLine in normalized.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = stripInlineTags(String(rawLine)).trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line == "WEBVTT" || line.hasPrefix("NOTE") || line.allSatisfy(\.isNumber) { continue }
            if line.contains("-->") { continue }
            if cleaned.last == line { continue }
            cleaned.append(line)
        }
        let meta = JSONValue.makeObject {
            ("year", .int(Int64(year)))
            ("sessionId", .string(sessionID))
            ("source", .string("asciiwwdc"))
        }
        let sections = [
            DocumentSectionRecord(
                sectionKind: "content",
                heading: "Transcript",
                contentText: cleaned.joined(separator: "\n"),
                sortOrder: 0
            )
        ]
        return makeSessionDocument(
            key: key,
            title: title,
            playURL: "\(applePlayBase)/wwdc\(year)/\(sessionID)/",
            abstractText: nil,
            metadata: meta,
            sections: sections
        )
    }

    private static func makeSessionDocument(
        key: DocumentKey,
        title: String,
        playURL: String,
        abstractText: String?,
        metadata: JSONValue,
        sections: [DocumentSectionRecord]
    ) -> ConvertedDocument {
        let record = DocumentRecord(
            key: key,
            sourceType: .wwdc,
            title: title,
            kind: "wwdc-session",
            role: "article",
            framework: rootSlug,
            url: playURL,
            abstractText: abstractText,
            urlDepth: max(0, key.rawValue.split(separator: "/").count - 1),
            sourceMetadataJSON: JSONValue.jsonString(metadata)
        )
        return ConvertedDocument(document: record, sections: sections)
    }

    private static func extractAsciiTitle(_ text: String, year: Int, sessionID: String) -> String {
        if text.contains("WEBVTT") { return "WWDC\(year) Session \(sessionID)" }
        if let first = text.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty }),
            !first.contains("-->"), !first.hasPrefix("["), first.count < 200
        {
            return first
        }
        return "WWDC\(year) Session \(sessionID)"
    }

    private static func stripInlineTags(_ line: String) -> String {
        var out = ""
        var inTag = false
        for ch in line {
            if ch == "<" {
                inTag = true
                continue
            }
            if ch == ">", inTag {
                inTag = false
                continue
            }
            if !inTag { out.append(ch) }
        }
        return out
    }
}
