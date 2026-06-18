public import ADJSONCore

public enum ContentText {
    /// renderContentNodesToText: blocks joined with '' (no separators).
    public static func renderNodes(_ nodes: JSON?, refs: PageMarkdown.Refs, into w: inout ByteWriter) {
        guard let nodes, nodes.isArray else { return }
        nodes.forEachElement { node in
            renderNode(node, refs, &w)
        }
    }

    static func renderNode(_ node: JSON, _ refs: PageMarkdown.Refs, _ w: inout ByteWriter) {
        guard node.isObject else { return }
        let type = node.member("type")

        if let type, type.utf8Equals("paragraph") {
            renderInline(node.member("inlineContent"), refs, &w)
            w.append(0x0A)
            return
        }
        if let type, type.utf8Equals("heading") {
            // `node.text ?? renderInline(...)` then `${text ?? ''}`.
            if let text = node.member("text"), !text.isNull {
                w.appendCoercion(text)
            } else {
                renderInline(node.member("inlineContent"), refs, &w)
            }
            w.append(0x0A)
            return
        }
        if let type, type.utf8Equals("codeListing") {
            if let code = node.member("code"), code.isArray {
                var first = true
                code.forEachElement { line in
                    if !first { w.append(0x0A) }
                    first = false
                    if !line.isNull { w.appendCoercion(line) }
                }
            }
            w.append(0x0A)
            return
        }
        if let type, type.utf8Equals("unorderedList") || type.utf8Equals("orderedList") {
            if let items = node.member("items"), items.isArray {
                items.forEachElement { item in
                    if item.isObject {
                        renderNodes(item.member("content"), refs: refs, into: &w)
                    }
                }
            }
            return
        }
        if let type, type.utf8Equals("aside") {
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
            return
        }
        if let type, type.utf8Equals("table") {
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
            return
        }
        if let type, type.utf8Equals("links") {
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
            return
        }
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
        // Best-effort default: truthy text → String(text); truthy code →
        // String(code); else recurse into inlineContent / content arrays.
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
