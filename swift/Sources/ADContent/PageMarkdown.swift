public import ADJSONCore

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

public enum PageMarkdown {
    /// Read + parse + render one raw DocC JSON file into `out` (the final
    /// finished document bytes). false on any trouble — the JS path serves
    /// that page instead.
    public static func convertFile(
        absolutePath: String, canonicalPath: String, scratch: inout ByteWriter, out: inout [UInt8]
    ) -> Bool {
        let fd = open(absolutePath, O_RDONLY)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_size >= 0, info.st_size <= 1 << 30 else { return false }
        var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
        var done = 0
        let wanted = bytes.count
        let ok = bytes.withUnsafeMutableBytes { buffer -> Bool in
            while done < wanted {
                let n = read(fd, buffer.baseAddress! + done, wanted - done)
                if n <= 0 { return false }
                done += n
            }
            return true
        }
        guard ok else { return false }
        return bytes.withUnsafeBytes { raw -> Bool in
            guard let doc = try? ADJSON.parse(raw, options: .init(maxDepth: 512)) else { return false }
            scratch.removeAll()
            render(doc.root, canonicalPath: canonicalPath, into: &scratch)
            ByteOps.finishDocument(scratch.bytes, into: &out, trailingNewline: true)
            return true
        }
    }

    /// Parse + render raw DocC JSON bytes into `w` (the UNFINISHED parts
    /// stream). false when the JSON can't be parsed. The buffer is borrowed
    /// for the parse, so all reads complete before this returns.
    ///
    /// The `maxDepth: 512` cap bounds container nesting, so the recursive
    /// content/inline walk below can't be driven past 512 frames by request
    /// input — the renderer never recurses deeper than the parse accepted.
    public static func renderRawJSON(_ raw: ByteSpan, canonicalPath: String, into w: inout ByteWriter) -> Bool {
        guard let doc = try? ADJSON.parse(raw, options: .init(maxDepth: 512)) else { return false }
        render(doc.root, canonicalPath: canonicalPath, into: &w)
        return true
    }

    /// Test/compat wrapper: full render to a String.
    public static func render(_ root: JSON, canonicalPath: String) -> String {
        var writer = ByteWriter()
        render(root, canonicalPath: canonicalPath, into: &writer)
        var out: [UInt8] = []
        ByteOps.finishDocument(writer.bytes, into: &out, trailingNewline: true)
        return String(decoding: out, as: UTF8.self)
    }

    /// Renders the UNFINISHED parts stream (caller applies
    /// ByteOps.finishDocument — `parts.join('\n').replace(/\n{3,}/).trim()+'\n'`).
    public static func render(_ root: JSON, canonicalPath: String, into w: inout ByteWriter) {
        let isObject = root.isObject
        let meta = isObject ? root.member("metadata") : nil
        let refs = Refs(references: isObject ? root.member("references") : nil)
        var parts = PartsWriter()

        parts.begin(&w)
        frontMatter(meta: meta, canonicalPath: canonicalPath, into: &w)
        parts.begin(&w)  // the '' part after front matter

        if let title = member(meta, "title"), title.isTruthy {
            parts.begin(&w)
            w.append("# ")
            w.appendCoercion(title)
            parts.begin(&w)
        }

        if let abstract = member(root, "abstract"), abstract.isArray,
            abstract.count > 0
        {
            parts.begin(&w)
            renderInline(abstract, refs, canonicalPath, &w)
            parts.begin(&w)
        }

        if let sections = member(root, "primaryContentSections"), sections.isArray {
            sections.forEachElement { section in
                // Non-object sections have no kind/content — JS's default branch
                // pushes nothing.
                guard section.isObject else { return }
                let kind = section.member("kind")
                if let kind, kind.utf8Equals("declarations") {
                    parts.begin(&w)
                    renderDeclarations(section, &w)
                } else if let kind, kind.utf8Equals("parameters") {
                    parts.begin(&w)
                    renderParameters(section, &w)
                } else if let kind, kind.utf8Equals("content") {
                    parts.begin(&w)
                    renderContentNodes(section.member("content"), refs, canonicalPath, &w)
                } else if let kind, kind.utf8Equals("mentions") {
                    // metadata, not content — JS pushes nothing for this section
                } else if let content = section.member("content") {
                    parts.begin(&w)
                    renderContentNodes(content, refs, canonicalPath, &w)
                }
            }
        }

        let linkBlocks: [(String, StaticString)] = [
            ("topicSections", "## Topics"),
            ("relationshipsSections", "## Relationships"),
            ("seeAlsoSections", "## See Also")
        ]
        for (field, heading) in linkBlocks {
            guard let sections = member(root, field), sections.isArray,
                sections.count > 0
            else { continue }
            parts.begin(&w)
            w.append(heading)
            parts.begin(&w)
            sections.forEachElement { section in
                parts.begin(&w)
                if section.isObject {
                    renderLinkSection(section, refs, canonicalPath, &w)
                } else {
                    // JS renderLinkSection on a non-object pushes just the trailing ''.
                }
            }
        }
    }

    /// `obj?.[key]` over an optional object node.
    @inline(__always)
    static func member(_ object: JSON?, _ key: String) -> JSON? {
        guard let object, object.isObject else { return nil }
        return object.member(key)
    }

    static func frontMatter(meta: JSON?, canonicalPath: String, into w: inout ByteWriter) {
        w.append("---")
        func field(_ name: StaticString, _ node: JSON?) {
            guard let node, !node.isNull else { return }
            w.append(0x0A)
            w.append(name)
            w.append(": ")
            appendYamlScalar(node, &w)
        }
        field("title", member(meta, "title"))
        let modules = member(meta, "modules")
        let firstModule = modules.flatMap { $0.firstElement }
        field("framework", firstModule.flatMap { $0.isObject ? $0.member("name") : nil })
        field("role", member(meta, "role"))
        field("role_heading", member(meta, "roleHeading"))
        // platforms: always present (`?? []`) — emitted even when empty.
        w.append("\nplatforms: [")
        var first = true
        if let platforms = member(meta, "platforms"), platforms.isArray {
            platforms.forEachElement { platform in
                let obj = platform.isObject ? platform : nil
                let introduced = obj.flatMap { $0.member("introducedAt") }
                let name = obj.flatMap { $0.member("name") }
                if let introduced, introduced.isTruthy {
                    if !first { w.append(", ") }
                    first = false
                    // `${p.name} ${p.introducedAt}+` — missing name interpolates as
                    // "undefined", faithfully. Quoting applies to the whole item.
                    var item = ByteWriter(capacity: 64)
                    if let name {
                        item.appendCoercion(name)
                    } else {
                        item.append("undefined")
                    }
                    item.append(0x20)
                    item.appendCoercion(introduced)
                    item.append(0x2B)
                    appendYamlQuoted(item.bytes, &w)
                } else if let name, name.isTruthy {
                    if !first { w.append(", ") }
                    first = false
                    var item = ByteWriter(capacity: 32)
                    item.appendCoercion(name)
                    appendYamlQuoted(item.bytes, &w)
                }
            }
        }
        w.append(0x5D)
        w.append("\npath: ")
        var item = ByteWriter(capacity: canonicalPath.utf8.count)
        item.append(canonicalPath)
        appendYamlQuoted(item.bytes, &w)
        w.append("\n---")
    }

    /// toFrontMatter scalar: String(value) then quoteIfNeeded.
    static func appendYamlScalar(_ node: JSON, _ w: inout ByteWriter) {
        var item = ByteWriter(capacity: 64)
        item.appendCoercion(node)
        appendYamlQuoted(item.bytes, &w)
    }

    /// yaml.js quoteIfNeeded over raw bytes.
    static func appendYamlQuoted(_ value: [UInt8], _ w: inout ByteWriter) {
        if FrontMatter.needsQuotingBytes(value) {
            w.append(0x22)
            for byte in value {
                if byte == UInt8(ascii: "\\") {
                    w.append("\\\\")
                } else if byte == 0x22 {
                    w.append("\\\"")
                } else {
                    w.append(byte)
                }
            }
            w.append(0x22)
        } else {
            w.bytes.append(contentsOf: value)
        }
    }

    static func renderDeclarations(_ section: JSON, _ w: inout ByteWriter) {
        w.append("## Declaration\n")
        if let declarations = section.member("declarations"), declarations.isArray {
            declarations.forEachElement { declaration in
                w.append(0x0A)
                let obj = declaration.isObject ? declaration : nil
                w.append("```")
                appendFirstLanguage(obj, &w)
                w.append(0x0A)
                if let tokens = obj.flatMap({ $0.member("tokens") }), tokens.isArray {
                    tokens.forEachElement { token in
                        // `.map(t => t.text).join('')` — join coerces undefined/null
                        // elements to '' (NOT "undefined").
                        if token.isObject, let text = token.member("text"),
                            !text.isNull
                        {
                            w.appendCoercion(text)
                        }
                    }
                }
                w.append("\n```\n")
            }
        }
        // The trailing '' line of lines.join('\n') is the final \n already
        // appended per block; JS also leaves one trailing '' element — the
        // outer parts machinery reproduces it via the next separator.
    }

    static func appendFirstLanguage(_ declaration: JSON?, _ w: inout ByteWriter) {
        if let languages = declaration.flatMap({ $0.member("languages") }),
            let first = languages.firstElement, !first.isNull
        {
            w.appendCoercion(first)
        } else {
            w.append("swift")
        }
    }

    static func renderParameters(_ section: JSON, _ w: inout ByteWriter) {
        w.append("## Parameters\n")
        if let parameters = section.member("parameters"), parameters.isArray {
            parameters.forEachElement { parameter in
                let obj = parameter.isObject ? parameter : nil
                w.append("\n- `")
                if let name = obj.flatMap({ $0.member("name") }), !name.isNull {
                    w.appendCoercion(name)
                }
                w.append("`: ")
                if let content = obj.flatMap({ $0.member("content") }), content.isTruthy {
                    // map(renderContentNode).join(' ') then trim.
                    let mark = w.count
                    var firstNode = true
                    content.forEachElement { node in
                        if !firstNode { w.append(0x20) }
                        firstNode = false
                        renderContentNode(node, .none, "", &w)
                    }
                    w.trim(since: mark)
                }
            }
        }
        w.append(0x0A)
    }

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

        init(references: JSON?) {
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

        func lookup(_ id: String) -> JSON? {
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

    static func renderContentNode(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        guard node.isObject else { return }
        let type = node.member("type")

        if let type, type.utf8Equals("paragraph") {
            renderInline(node.member("inlineContent"), refs, fromPath, &w)
            w.append(0x0A)
            return
        }
        if let type, type.utf8Equals("heading") {
            let level = node.member("level").map { $0.double ?? 0 } ?? 2
            // '#'.repeat(ToInteger(level)) — NaN/∞/huge must not trap (no-trap
            // rule; Int(Double) aborts beyond Int64). Real levels are 1-6; the
            // 2^20 ceiling only guards adversarial JSON.
            let hashes = level.isFinite ? max(0, Int(min(level, 1_048_576))) : 0
            for _ in 0 ..< hashes { w.append(0x23) }
            w.append(0x20)
            if let text = node.member("text"), !text.isNull {
                w.appendCoercion(text)
            } else {
                renderInline(node.member("inlineContent"), refs, fromPath, &w)
            }
            w.append(0x0A)
            return
        }
        if let type, type.utf8Equals("codeListing") {
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
            return
        }
        if let type, type.utf8Equals("unorderedList") {
            renderList(node, refs, fromPath, ordered: false, &w)
            return
        }
        if let type, type.utf8Equals("orderedList") {
            renderList(node, refs, fromPath, ordered: true, &w)
            return
        }
        if let type, type.utf8Equals("aside") {
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
            return
        }
        if let type, type.utf8Equals("table") {
            renderTable(node, refs, fromPath, &w)
            return
        }
        if let type, type.utf8Equals("links") {
            if let items = node.member("items"), items.isArray {
                var first = true
                items.forEachElement { idValue in
                    if !first { w.append(0x0A) }
                    first = false
                    appendLinkItem(idValue, refs, fromPath, &w)
                }
            }
            w.append(0x0A)
            return
        }
        // default: truthy inlineContent → inline + \n; truthy content → nodes.
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

    static func renderInline(_ nodes: JSON?, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        guard let nodes, nodes.isArray else { return }
        nodes.forEachElement { node in
            renderInlineNode(node, refs, fromPath, &w)
        }
    }

    static func renderInlineNode(_ node: JSON, _ refs: Refs, _ fromPath: String, _ w: inout ByteWriter) {
        guard node.isObject else { return }
        let type = node.member("type")

        if let type, type.utf8Equals("text") {
            if let text = node.member("text"), !text.isNull {
                w.appendCoercion(text)
            }
            return
        }
        if let type, type.utf8Equals("codeVoice") {
            w.append(0x60)
            if let code = node.member("code"), !code.isNull {
                w.appendCoercion(code)
            }
            w.append(0x60)
            return
        }
        if let type, type.utf8Equals("emphasis") {
            w.append(0x2A)
            renderInline(node.member("inlineContent"), refs, fromPath, &w)
            w.append(0x2A)
            return
        }
        if let type,
            type.utf8Equals("strong") || type.utf8Equals("newTerm")
                || type.utf8Equals("inlineHead")
        {
            w.append("**")
            renderInline(node.member("inlineContent"), refs, fromPath, &w)
            w.append("**")
            return
        }
        if let type, type.utf8Equals("reference") {
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
            return
        }
        if let type, type.utf8Equals("link") {
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
            return
        }
        if let type, type.utf8Equals("superscript") || type.utf8Equals("subscript") {
            renderInline(node.member("inlineContent"), refs, fromPath, &w)
            return
        }
        if let type, type.utf8Equals("strikethrough") {
            w.append("~~")
            renderInline(node.member("inlineContent"), refs, fromPath, &w)
            w.append("~~")
            return
        }
        if let type, type.utf8Equals("image") {
            w.append("![")
            if let alt = node.member("alt"), !alt.isNull {
                w.appendCoercion(alt)
            }
            w.append("](")
            if let source = node.member("source"), !source.isNull {
                w.appendCoercion(source)
            }
            w.append(0x29)
            return
        }
        // default: text ?? code ?? ''
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
    public static func relativePath(from fromPath: String, to toPath: String) -> String {
        if fromPath.isEmpty || toPath.isEmpty { return toPath }
        let fromDirCount = fromPath.reduce(into: 0) { if $1 == "/" { $0 += 1 } }
        let toDirCount = toPath.reduce(into: 0) { if $1 == "/" { $0 += 1 } }
        var fromRest = fromPath[...]
        var toRest = toPath[...]
        var common = 0
        let maxCommon = min(fromDirCount, toDirCount)
        while common < maxCommon,
            let fSlash = fromRest.firstIndex(of: "/"), let tSlash = toRest.firstIndex(of: "/"),
            fromRest[..<fSlash] == toRest[..<tSlash]
        {
            common += 1
            fromRest = fromRest[fromRest.index(after: fSlash)...]
            toRest = toRest[toRest.index(after: tSlash)...]
        }
        let climbs = fromDirCount - common
        if climbs == 0 { return String(toRest) }
        var result = String(repeating: "../", count: climbs)
        result.append(contentsOf: toRest)
        return result
    }
}

/// `parts: []` + `parts.join('\n')` reproduced as a separator protocol:
/// every `parts.push(x)` is `begin()` (separator when not first) followed
/// by the content writes; pushing '' is a bare `begin()`.
struct PartsWriter {
    var first = true

    mutating func begin(_ w: inout ByteWriter) {
        if !first { w.append(0x0A) }
        first = false
    }
}
