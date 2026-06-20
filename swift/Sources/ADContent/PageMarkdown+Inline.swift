import ADJSONCore

// Inline-level markdown rendering for `PageMarkdown` (text / code / marks / reference / link /
// image dispatch). Split from PageMarkdown.swift to keep the enum body within the gate.
extension PageMarkdown {
    static func renderInline(_ nodes: JSON?, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        guard let nodes, nodes.isArray else { return }
        nodes.forEachElement { node in
            renderInlineNode(node, refs, fromPath, &w)
        }
    }

    /// The markdown inline-node kinds `renderInlineNode` dispatches on.
    enum InlineType {
        case text, codeVoice, emphasis, strongMark, reference, link, plainMark, strikethrough, image, other
    }

    static func inlineType(_ type: JSON?) -> InlineType {
        guard let type else { return .other }
        if type.utf8Equals("text") { return .text }
        if type.utf8Equals("codeVoice") { return .codeVoice }
        if type.utf8Equals("emphasis") { return .emphasis }
        if type.utf8Equals("strong") || type.utf8Equals("newTerm") || type.utf8Equals("inlineHead") {
            return .strongMark
        }
        if type.utf8Equals("reference") { return .reference }
        if type.utf8Equals("link") { return .link }
        if type.utf8Equals("superscript") || type.utf8Equals("subscript") { return .plainMark }
        if type.utf8Equals("strikethrough") { return .strikethrough }
        if type.utf8Equals("image") { return .image }
        return .other
    }

    static func renderInlineNode(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        guard node.isObject else { return }
        switch inlineType(node.member("type")) {
            case .text:
                if let text = node.member("text"), !text.isNull { w.appendCoercion(text) }
            case .codeVoice:
                w.append(0x60)
                if let code = node.member("code"), !code.isNull { w.appendCoercion(code) }
                w.append(0x60)
            case .emphasis:
                w.append(0x2A)
                renderInline(node.member("inlineContent"), refs, fromPath, &w)
                w.append(0x2A)
            case .strongMark:
                w.append("**")
                renderInline(node.member("inlineContent"), refs, fromPath, &w)
                w.append("**")
            case .reference:
                renderReferenceNode(node, refs, fromPath, &w)
            case .link:
                renderLinkNode(node, &w)
            case .plainMark:
                renderInline(node.member("inlineContent"), refs, fromPath, &w)
            case .strikethrough:
                w.append("~~")
                renderInline(node.member("inlineContent"), refs, fromPath, &w)
                w.append("~~")
            case .image:
                renderImageNode(node, &w)
            case .other:
                renderInlineDefault(node, &w)
        }
    }

    // `[title](relativePath.md)` when the reference resolves to a normalizable path and is active,
    // else `` `title` `` inline code. `title` is `ref.title ?? node.identifier ?? ''`.
    static func renderReferenceNode(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        let identifier = node.member("identifier")
        let id = identifier.flatMap { $0.string }
        let ref = id.flatMap { refs.lookup($0) }
        // normalizeIdentifier(node.identifier ?? ref?.url) — string-guarded.
        var normSource: String? = id
        if normSource == nil, identifier == nil || identifier!.isNull {
            if let url = ref.flatMap({ $0.member("url") }), let urlString = url.string {
                normSource = urlString
            }
        }
        let normPath = Identifier.normalize(normSource)
        var isActiveFalse = false
        if let isActive = node.member("isActive"), isActive.bool == false {
            isActiveFalse = true
        }
        func appendTitle() {
            if let title = ref.flatMap({ $0.member("title") }), !title.isNull {
                w.appendCoercion(title)
            } else if let identifier, !identifier.isNull {
                w.appendCoercion(identifier)
            }
        }
        if let normPath, !isActiveFalse {
            w.append(0x5B)
            appendTitle()
            w.append("](")
            w.append(relativePath(from: fromPath, to: normPath))
            w.append(".md)")
        } else {
            w.append(0x60)
            appendTitle()
            w.append(0x60)
        }
    }

    // `[title ?? destination](destination)`.
    static func renderLinkNode(_ node: JSON, _ w: inout ByteWriter) {
        let destination = node.member("destination")
        let hasDestination = destination.map { !$0.isNull } ?? false
        w.append(0x5B)
        if let title = node.member("title"), !title.isNull {
            w.appendCoercion(title)
        } else if hasDestination {
            w.appendCoercion(destination!)
        }
        w.append("](")
        if hasDestination { w.appendCoercion(destination!) }
        w.append(0x29)
    }

    // `![alt](source)`.
    static func renderImageNode(_ node: JSON, _ w: inout ByteWriter) {
        w.append("![")
        if let alt = node.member("alt"), !alt.isNull {
            w.appendCoercion(alt)
        }
        w.append("](")
        if let source = node.member("source"), !source.isNull {
            w.appendCoercion(source)
        }
        w.append(0x29)
    }

    // default: text ?? code ?? ''
    static func renderInlineDefault(_ node: JSON, _ w: inout ByteWriter) {
        if let text = node.member("text"), !text.isNull {
            w.appendCoercion(text)
        } else if let code = node.member("code"), !code.isNull {
            w.appendCoercion(code)
        }
    }

    /// relativePath: directory-to-directory common prefix, then `..` climbs
    /// + target path. Scans segments by index (no split/parts/join arrays);
    /// the directory segment count is the number of `/` (split keeps empties,
    /// then drops the file), and once both rests are advanced past the common
    /// prefix the remaining toDir segments plus the file are exactly the
    /// trailing substring, so `../`-climbs + that substring is the joined result.
}
