import ADBase
public import ADJSONCore

// Block-level markdown rendering for `PageMarkdown` (link sections, content-node dispatch, lists,
// tables). Split from PageMarkdown.swift to keep the enum body within the size/complexity gate.
extension PageMarkdown {
    static func renderLinkSection(
        _ section: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter
    ) {
        var first = true
        func line() {
            if !first { w.append(0x0A) }
            first = false
        }
        if let title = section.member("title"), title.isTruthy {
            line()
            w.append("### ")
            w.appendCoercion(title)
            line()  // ''
        }
        if let identifiers = section.member("identifiers"), identifiers.isArray {
            identifiers.forEachElement { idValue in
                line()
                appendLinkItem(idValue, refs, fromPath, &w)
            }
        }
        line()  // trailing ''
    }

    /// One `- [title](rel.md)` / `- title` line (shared by link sections and
    /// the `links` content node).
    static func appendLinkItem(_ idValue: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        let id = idValue.string
        let ref = id.flatMap { refs.lookup($0) }
        let normPath = Identifier.normalize(id)
        w.append("- ")
        if let normPath {
            w.append(0x5B)
            if let title = ref.flatMap({ $0.member("title") }), !title.isNull {
                w.appendCoercion(title)
            } else {
                w.append(normPath)
            }
            w.append("](")
            w.append(relativePath(from: fromPath, to: normPath))
            w.append(".md)")
        } else {
            if let title = ref.flatMap({ $0.member("title") }), !title.isNull {
                w.appendCoercion(title)
            } else {
                w.appendCoercion(idValue)  // `?? id` — null → "null"
            }
        }
    }

    /// The references map: keys are looked up by DYNAMIC id many times per
    /// page (big pages carry hundreds of refs × hundreds of reference
    /// nodes), so one Dictionary built per page replaces per-node linear
    /// scans — the one place hashing pays for itself.
    public struct Refs: Sendable {
        let index: [String: JSON]?

        /// Build a per-page reference index from a DocC `references` object node (or `nil`).
        /// Public so out-of-module DocC consumers (the ADBuilder DocC-JSON normalizer) can
        /// build the index ONCE per page and reuse it across the `ContentText` render calls.
        public init(references: JSON?) {
            guard let references, references.isObject else {
                index = nil
                return
            }
            var built: [String: JSON] = Dictionary(minimumCapacity: references.count)
            references.forEachMember { key, value in
                // First occurrence wins position; dup keys were already routed
                // through the eager parser, so plain insert-if-absent is exact.
                if built[key] == nil { built[key] = value }
            }
            index = built
        }

        static let none = Refs(index: nil)

        private init(index: [String: JSON]?) {
            self.index = index
        }

        /// Resolve a reference id to its (object) node, or `nil`. Public so the ADBuilder DocC-JSON
        /// normalizer can reuse the one per-page index for reference-key + title resolution.
        public func lookup(_ id: String) -> JSON? {
            guard let found = index?[id], found.isObject else { return nil }
            return found
        }
    }

    static func renderContentNodes(
        _ nodes: JSON?, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter
    ) {
        guard let nodes, nodes.isArray else { return }
        var first = true
        nodes.forEachElement { node in
            if !first { w.append(0x0A) }
            first = false
            renderContentNode(node, refs, fromPath, &w)
        }
    }

    /// The markdown block-node kinds `renderContentNode` dispatches on.
    enum BlockType {
        case paragraph, heading, codeListing, unorderedList, orderedList, aside, table, links, other
    }

    static func blockType(_ type: JSON?) -> BlockType {
        guard let type else { return .other }
        if type.utf8Equals("paragraph") { return .paragraph }
        if type.utf8Equals("heading") { return .heading }
        if type.utf8Equals("codeListing") { return .codeListing }
        if type.utf8Equals("unorderedList") { return .unorderedList }
        if type.utf8Equals("orderedList") { return .orderedList }
        if type.utf8Equals("aside") { return .aside }
        if type.utf8Equals("table") { return .table }
        if type.utf8Equals("links") { return .links }
        return .other
    }

    static func renderContentNode(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        guard node.isObject else { return }
        switch blockType(node.member("type")) {
            case .paragraph:
                renderInline(node.member("inlineContent"), refs, fromPath, &w)
                w.append(0x0A)
            case .heading:
                renderHeadingNode(node, refs, fromPath, &w)
            case .codeListing:
                renderCodeListingNode(node, &w)
            case .unorderedList:
                renderList(node, refs, fromPath, ordered: false, &w)
            case .orderedList:
                renderList(node, refs, fromPath, ordered: true, &w)
            case .aside:
                renderAsideNode(node, refs, fromPath, &w)
            case .table:
                renderTable(node, refs, fromPath, &w)
            case .links:
                renderLinksNode(node, refs, fromPath, &w)
            case .other:
                renderBlockDefault(node, refs, fromPath, &w)
        }
    }

    // `#`×level + ' ' + (text ?? inline) + newline. `level` is ToInteger-clamped so NaN/∞/huge
    // can't trap (Int(Double) aborts beyond Int64); the 2^20 ceiling only guards adversarial JSON.
    static func renderHeadingNode(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        let level = node.member("level").map { $0.double ?? 0 } ?? 2
        let hashes = level.isFinite ? max(0, Int(min(level, 1_048_576))) : 0
        for _ in 0 ..< hashes { w.append(0x23) }
        w.append(0x20)
        if let text = node.member("text"), !text.isNull {
            w.appendCoercion(text)
        } else {
            renderInline(node.member("inlineContent"), refs, fromPath, &w)
        }
        w.append(0x0A)
    }

    // ```syntax\n<code lines>\n``` fenced block.
    static func renderCodeListingNode(_ node: JSON, _ w: inout ByteWriter) {
        w.append("```")
        if let syntax = node.member("syntax"), !syntax.isNull {
            w.appendCoercion(syntax)
        }
        w.append(0x0A)
        if let code = node.member("code"), code.isArray {
            var first = true
            code.forEachElement { line in
                if !first { w.append(0x0A) }
                first = false
                if !line.isNull { w.appendCoercion(line) }
            }
        }
        w.append("\n```\n")
    }

    // `> **${style ?? 'Note'}:** ${content}` blockquote, trailing whitespace trimmed.
    static func renderAsideNode(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        w.append("> **")
        if let style = node.member("style"), !style.isNull {
            w.appendCoercion(style)
        } else {
            w.append("Note")
        }
        w.append(":** ")
        let mark = w.count
        renderContentNodes(node.member("content"), refs, fromPath, &w)
        w.trim(since: mark)
        w.append(0x0A)
    }

    // A `links` block: each item id rendered via `appendLinkItem`, joined with newlines.
    static func renderLinksNode(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        if let items = node.member("items"), items.isArray {
            var first = true
            items.forEachElement { idValue in
                if !first { w.append(0x0A) }
                first = false
                appendLinkItem(idValue, refs, fromPath, &w)
            }
        }
        w.append(0x0A)
    }

    // default: truthy inlineContent → inline + newline; truthy content → nodes.
    static func renderBlockDefault(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        if let inline = node.member("inlineContent"), inline.isTruthy {
            renderInline(inline, refs, fromPath, &w)
            w.append(0x0A)
            return
        }
        if let content = node.member("content"), content.isTruthy {
            renderContentNodes(content, refs, fromPath, &w)
        }
    }

    static func renderList(
        _ node: JSON, _ refs: Refs, _ fromPath: String, ordered: Bool, _ w: inout ByteWriter
    ) {
        if let items = node.member("items"), items.isArray {
            var index = 0
            items.forEachElement { item in
                if index > 0 { w.append(0x0A) }
                if ordered {
                    w.append(JSONOutput.ecmaNumberToString(Double(index + 1)))
                    w.append(". ")
                } else {
                    w.append("- ")
                }
                let mark = w.count
                if item.isObject, let content = item.member("content"),
                    content.isArray
                {
                    content.forEachElement { child in
                        renderContentNode(child, refs, fromPath, &w)
                    }
                }
                w.trim(since: mark)
                index += 1
            }
        }
        w.append(0x0A)
    }

    static func renderTable(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        guard let rows = node.member("rows"), rows.isArray,
            let firstRow = rows.firstElement
        else { return }

        func forEachCell(_ row: JSON, _ body: (JSON) -> Void) {
            if row.isArray {
                row.forEachElement(body)
            } else if row.isObject, let cells = row.member("cells"),
                cells.isArray
            {
                cells.forEachElement(body)
            }
        }
        func renderCell(_ cell: JSON) {
            let mark = w.count
            if cell.isObject, let content = cell.member("content"),
                content.isArray
            {
                content.forEachElement { child in
                    renderContentNode(child, refs, fromPath, &w)
                }
            }
            w.trim(since: mark)
            w.newlinesToSpaces(since: mark)
        }

        var headerCount = 0
        w.append("| ")
        var firstCell = true
        forEachCell(firstRow) { cell in
            if !firstCell { w.append(" | ") }
            firstCell = false
            renderCell(cell)
            headerCount += 1
        }
        w.append(" |\n| ")
        for i in 0 ..< headerCount {
            if i > 0 { w.append(" | ") }
            w.append("---")
        }
        w.append(" |")
        var skippedFirst = false
        rows.forEachElement { row in
            if !skippedFirst {
                skippedFirst = true
                return
            }
            w.append("\n| ")
            var first = true
            forEachCell(row) { cell in
                if !first { w.append(" | ") }
                first = false
                renderCell(cell)
            }
            w.append(" |")
        }
        w.append(0x0A)
    }

}
