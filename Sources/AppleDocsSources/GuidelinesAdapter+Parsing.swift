import AemiHTML
import AppleDocsCore
import Foundation

extension GuidelinesAdapter {
    static func parseSnapshot(html: [UInt8], etag: String?) -> Snapshot {
        let doc = HTMLParser.parse(html)
        let container = findContentContainer(in: doc)
        let sidenavNodes = findSidenavNodes(in: doc, under: container)
        let boundarySet = Set(sidenavNodes)
        var parsed = sidenavNodes.compactMap { extractSection(from: $0, in: doc, boundaries: boundarySet) }
        wireParentChildHierarchy(&parsed)
        var byKey: [String: ParsedSection] = [:]
        var ordered: [DocumentKey] = []
        for item in parsed where byKey[item.key.rawValue] == nil {
            byKey[item.key.rawValue] = item
            ordered.append(item.key)
        }
        return Snapshot(etag: etag, sectionsByKey: byKey, orderedKeys: ordered)
    }

    private static func findContentContainer(in doc: HTMLDocument) -> HTMLDocument.Node {
        for node in doc.descendants(of: doc.root) where doc.kind(node) == .element {
            if let id = doc.attribute("id", of: node), id.elementsEqual("content-container".utf8) {
                return node
            }
        }
        return doc.root
    }

    private static func findSidenavNodes(
        in doc: HTMLDocument,
        under container: HTMLDocument.Node
    ) -> [HTMLDocument.Node] {
        var nodes: [HTMLDocument.Node] = []
        for node in doc.descendants(of: container) where doc.kind(node) == .element {
            if doc.isElement(node, "h3") || doc.isElement(node, "li"), doc.attribute("data-sidenav", of: node) != nil {
                nodes.append(node)
            }
        }
        return nodes
    }

    private static func extractSection(
        from node: HTMLDocument.Node,
        in doc: HTMLDocument,
        boundaries: Set<HTMLDocument.Node>
    ) -> ParsedSection? {
        let isH3 = doc.isElement(node, "h3")
        let id = doc.attribute("id", of: node).map { String(decoding: $0, as: UTF8.self) } ?? ""
        let sidenavTitle = doc.attribute("data-sidenav", of: node)
            .map { String(decoding: $0, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }
        let markdown =
            isH3
            ? collectH3SectionText(doc: doc, h3: node, boundaries: boundaries)
            : collectSubtreeText(doc: doc, root: node, boundaries: boundaries, skipRoot: true)
        let title = resolveTitle(id: id, sidenavTitle: sidenavTitle, markdown: markdown)
        let number = extractSectionNumber(title)
        let rawPath = number.map { "\(rootSlug)/\($0)" } ?? "\(rootSlug)/\(id.isEmpty ? "section" : id)"
        guard let key = try? DocumentKey(rawPath) else { return nil }
        return ParsedSection(
            id: id,
            key: key,
            title: title,
            abstractText: extractAbstract(markdown),
            markdown: markdown,
            role: isH3 ? "collection" : "article",
            roleHeading: isH3 ? "Section" : "Guideline",
            sectionNumber: number
        )
    }

    private static func wireParentChildHierarchy(_ parsed: inout [ParsedSection]) {
        var indexByNumber: [String: Int] = [:]
        for idx in parsed.indices {
            if let num = parsed[idx].sectionNumber { indexByNumber[num] = idx }
        }
        for idx in parsed.indices {
            guard let num = parsed[idx].sectionNumber, let parent = parentSectionNumber(num),
                let parentIdx = indexByNumber[parent]
            else { continue }
            parsed[parentIdx].children.append(parsed[idx].key)
        }
    }

    private static func collectH3SectionText(
        doc: HTMLDocument,
        h3: HTMLDocument.Node,
        boundaries: Set<HTMLDocument.Node>
    ) -> String {
        var blocks: [String] = []
        let heading = collectSubtreeText(doc: doc, root: h3, boundaries: boundaries, skipRoot: true)
        if !heading.isEmpty { blocks.append("### \(heading)") }
        var sib = doc.nextSibling(h3)
        while !sib.isNone {
            if boundaries.contains(sib) { break }
            let chunk = collectSubtreeText(doc: doc, root: sib, boundaries: boundaries, skipRoot: false)
            if !chunk.isEmpty { blocks.append(chunk) }
            sib = doc.nextSibling(sib)
        }
        return blocks.joined(separator: "\n\n")
    }

    private static func collectSubtreeText(
        doc: HTMLDocument,
        root: HTMLDocument.Node,
        boundaries: Set<HTMLDocument.Node>,
        skipRoot: Bool
    ) -> String {
        if !skipRoot, boundaries.contains(root) { return "" }
        if doc.kind(root) == .text {
            return AdapterHelpers.collapseWhitespace(String(decoding: doc.data(root), as: UTF8.self))
        }
        guard doc.kind(root) == .element else { return "" }
        if isIgnoredBadgeSpan(doc: doc, node: root) || doc.isElement(root, "script") || doc.isElement(root, "style") {
            return ""
        }
        var parts: [String] = []
        var child = doc.firstChild(root)
        while !child.isNone {
            let piece = collectSubtreeText(doc: doc, root: child, boundaries: boundaries, skipRoot: false)
            if !piece.isEmpty { parts.append(piece) }
            child = doc.nextSibling(child)
        }
        let isBlock = AdapterHelpers.isAnyElement(doc, root, ["p", "li", "ul", "ol", "div"])
        return parts.joined(separator: isBlock ? "\n\n" : " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isIgnoredBadgeSpan(doc: HTMLDocument, node: HTMLDocument.Node) -> Bool {
        guard doc.isElement(node, "span"),
            let cls = doc.attribute("class", of: node).map({ String(decoding: $0, as: UTF8.self) })
        else { return false }
        return cls.contains("custom-tooltip-icon") || cls.contains("loc-en-only")
            || cls.contains("loc-j") || cls.contains("loc-cj")
    }

    private static func resolveTitle(id: String, sidenavTitle: String?, markdown: String) -> String {
        if let sidenavTitle, !sidenavTitle.isEmpty { return sidenavTitle }
        if let first = markdown.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) })
            .first(where: { !$0.isEmpty })
        {
            let stripped = first.drop { $0 == "#" || $0 == " " }
            if !stripped.isEmpty { return String(stripped) }
        }
        return id.replacing("-", with: " ").capitalized
    }

    private static func extractSectionNumber(_ title: String) -> String? {
        var idx = title.startIndex
        guard idx < title.endIndex, title[idx].isNumber else { return nil }
        while idx < title.endIndex {
            let ch = title[idx]
            guard ch.isNumber || ch == "." || ch == "(" || ch == ")" || (ch >= "a" && ch <= "z") else {
                break
            }
            idx = title.index(after: idx)
        }
        let candidate = String(title[..<idx]).trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return candidate.isEmpty ? nil : candidate
    }

    private static func parentSectionNumber(_ num: String) -> String? {
        if let open = num.firstIndex(of: "("), num.hasSuffix(")") {
            return String(num[..<open])
        }
        guard let dot = num.lastIndex(of: ".") else { return nil }
        return String(num[..<dot])
    }

    private static func extractAbstract(_ markdown: String) -> String? {
        let lines = markdown.split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
        let joined = lines.joined(separator: " ")
        guard !joined.isEmpty else { return nil }
        if let period = joined.firstIndex(where: { $0 == "." || $0 == "!" || $0 == "?" }) {
            let sentence = String(joined[...period])
            return String(sentence.prefix(300))
        }
        return String(joined.prefix(300))
    }
}
