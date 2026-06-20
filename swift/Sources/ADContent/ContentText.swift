public import ADJSONCore

public enum ContentText {
    /// renderContentNodesToText: blocks joined with '' (no separators).
    public static func renderNodes(_ nodes: JSON?, refs: PageMarkdown.Refs, into w: inout ByteWriter) {
        guard let nodes, nodes.isArray else { return }
        nodes.forEachElement { node in
            renderNode(node, refs, &w)
        }
    }

    /// The content-node kinds `renderNode` dispatches on.
    enum NodeType {
        case paragraph, heading, codeListing, list, aside, table, links
        case text, codeVoice, inlineMark, reference, link, other
    }

    /// Classifies a content node by its `type` member, matched on raw UTF-8 (no String
    /// allocation on the render hot path). Folds the former `if`-chain dispatch into one
    /// place so `renderNode` is a flat `switch` (cyclomatically cheap).
    static func nodeType(_ type: JSON?) -> NodeType {
        guard let type else { return .other }
        if type.utf8Equals("paragraph") { return .paragraph }
        if type.utf8Equals("heading") { return .heading }
        if type.utf8Equals("codeListing") { return .codeListing }
        if type.utf8Equals("unorderedList") || type.utf8Equals("orderedList") { return .list }
        if type.utf8Equals("aside") { return .aside }
        if type.utf8Equals("table") { return .table }
        if type.utf8Equals("links") { return .links }
        if type.utf8Equals("text") { return .text }
        if type.utf8Equals("codeVoice") { return .codeVoice }
        if isInlineMark(type) { return .inlineMark }
        if type.utf8Equals("reference") { return .reference }
        if type.utf8Equals("link") { return .link }
        return .other
    }

    static func renderNode(_ node: JSON, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        guard node.isObject else { return }
        switch nodeType(node.member("type")) {
            case .paragraph:
                renderInline(node.member("inlineContent"), refs, &w)
                w.append(0x0A)
            case .heading:
                renderHeading(node, refs, &w)
            case .codeListing:
                renderCodeListing(node, &w)
            case .list:
                renderList(node, refs, &w)
            case .aside:
                renderAside(node, refs, &w)
            case .table:
                renderTable(node, refs, &w)
            case .links:
                renderLinks(node, refs, &w)
            case .text:
                if let text = node.member("text"), !text.isNull { w.appendCoercion(text) }
            case .codeVoice:
                if let code = node.member("code"), !code.isNull { w.appendCoercion(code) }
            case .inlineMark:
                renderInline(node.member("inlineContent"), refs, &w)
            case .reference:
                appendReferenceTitle(node, refs, &w)
            case .link:
                appendLinkText(node, &w)
            case .other:
                renderDefault(node, refs, &w)
        }
    }

    // `node.text ?? renderInline(...)` then a trailing newline.
    static func renderHeading(_ node: JSON, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        if let text = node.member("text"), !text.isNull {
            w.appendCoercion(text)
        } else {
            renderInline(node.member("inlineContent"), refs, &w)
        }
        w.append(0x0A)
    }

    // Code lines joined with newlines (null lines coerce to ''), then a trailing newline.
    static func renderCodeListing(_ node: JSON, _ w: inout ByteWriter) {
        if let code = node.member("code"), code.isArray {
            var first = true
            code.forEachElement { line in
                if !first { w.append(0x0A) }
                first = false
                if !line.isNull { w.appendCoercion(line) }
            }
        }
        w.append(0x0A)
    }

    // unorderedList / orderedList: recurse into each item's content.
    static func renderList(_ node: JSON, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        if let items = node.member("items"), items.isArray {
            items.forEachElement { item in
                if item.isObject {
                    renderNodes(item.member("content"), refs: refs, into: &w)
                }
            }
        }
    }

    // `${style ?? 'Note'}: ${content}` with trailing whitespace trimmed, then a newline.
    static func renderAside(_ node: JSON, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        if let style = node.member("style"), !style.isNull {
            w.appendCoercion(style)
        } else {
            w.append("Note")
        }
        w.append(": ")
        let mark = w.count
        renderNodes(node.member("content"), refs: refs, into: &w)
        w.trim(since: mark)
        w.append(0x0A)
    }

    // Rows joined with newlines; cells joined with ' | ' (each cell trimmed). A row may be a
    // bare cell array or an object with a `cells` array.
    static func renderTable(_ node: JSON, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        if let rows = node.member("rows"), rows.isArray {
            var firstRow = true
            rows.forEachElement { row in
                if !firstRow { w.append(0x0A) }
                firstRow = false
                var firstCell = true
                func renderCell(_ cell: JSON) {
                    if !firstCell { w.append(" | ") }
                    firstCell = false
                    let mark = w.count
                    if cell.isObject {
                        renderNodes(cell.member("content"), refs: refs, into: &w)
                    }
                    w.trim(since: mark)
                }
                if row.isArray {
                    row.forEachElement(renderCell)
                } else if row.isObject, let cells = row.member("cells"),
                    cells.isArray
                {
                    cells.forEachElement(renderCell)
                }
            }
        }
        w.append(0x0A)
    }

    // A `links` block: each item is a reference id → its title (or the normalized id, or the
    // id text), joined with newlines.
    static func renderLinks(_ node: JSON, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        if let items = node.member("items"), items.isArray {
            var first = true
            items.forEachElement { idValue in
                if !first { w.append(0x0A) }
                first = false
                let id = idValue.string
                if let id, let ref = refs.lookup(id),
                    let title = ref.member("title"), !title.isNull
                {
                    w.appendCoercion(title)
                } else if let id, let normalized = Identifier.normalize(id) {
                    w.append(normalized)
                } else if idValue.isNull {
                    // `?? id` then Array.join: null elements coerce to ''.
                } else if let id {
                    w.append(id)
                } else {
                    w.appendCoercion(idValue)
                }
            }
        }
        w.append(0x0A)
    }

    // Best-effort default: truthy text → String(text); truthy code → String(code); else
    // recurse into inlineContent / content arrays.
    static func renderDefault(_ node: JSON, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        if let text = node.member("text"), text.isTruthy {
            w.appendCoercion(text)
            return
        }
        if let code = node.member("code"), code.isTruthy {
            w.appendCoercion(code)
            return
        }
        if let inline = node.member("inlineContent"), inline.isArray {
            renderInline(inline, refs, &w)
            return
        }
        if let content = node.member("content"), content.isArray {
            renderNodes(content, refs: refs, into: &w)
        }
    }

    static func isInlineMark(_ type: JSON) -> Bool {
        type.utf8Equals("emphasis") || type.utf8Equals("strong")
            || type.utf8Equals("newTerm") || type.utf8Equals("inlineHead")
            || type.utf8Equals("superscript") || type.utf8Equals("subscript")
            || type.utf8Equals("strikethrough")
    }

    public static func renderInline(_ nodes: JSON?, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        guard let nodes, nodes.isArray else { return }
        nodes.forEachElement { node in
            guard node.isObject else { return }
            let type = node.member("type")
            if let type, type.utf8Equals("text") {
                if let text = node.member("text"), !text.isNull {
                    w.appendCoercion(text)
                }
                return
            }
            if let type, type.utf8Equals("codeVoice") {
                if let code = node.member("code"), !code.isNull {
                    w.appendCoercion(code)
                }
                return
            }
            if let type, isInlineMark(type) {
                renderInline(node.member("inlineContent"), refs, &w)
                return
            }
            if let type, type.utf8Equals("reference") {
                appendReferenceTitle(node, refs, &w)
                return
            }
            if let type, type.utf8Equals("link") {
                appendLinkText(node, &w)
                return
            }
            // default: text ?? code ?? ''
            if let text = node.member("text"), !text.isNull {
                w.appendCoercion(text)
            } else if let code = node.member("code"), !code.isNull {
                w.appendCoercion(code)
            }
        }
    }

    /// `refs?.[id]?.title ?? node.title ?? node.identifier ?? ''`
    static func appendReferenceTitle(_ node: JSON, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        let identifier = node.member("identifier")
        let id = identifier.flatMap { $0.string }
        if let id, let ref = refs.lookup(id),
            let title = ref.member("title"), !title.isNull
        {
            w.appendCoercion(title)
            return
        }
        if let title = node.member("title"), !title.isNull {
            w.appendCoercion(title)
            return
        }
        if let identifier, !identifier.isNull {
            w.appendCoercion(identifier)
        }
    }

    /// `node.title ?? node.destination ?? ''`
    static func appendLinkText(_ node: JSON, _ w: inout ByteWriter) {
        if let title = node.member("title"), !title.isNull {
            w.appendCoercion(title)
            return
        }
        if let destination = node.member("destination"), !destination.isNull {
            w.appendCoercion(destination)
        }
    }
}
