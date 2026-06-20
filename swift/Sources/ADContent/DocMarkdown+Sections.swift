import ADJSONCore

#if canImport(Darwin)
    import Darwin  // memcmp, used by spanEquals
#else
    import Glibc
#endif

// Section rendering for `DocMarkdown` (declarations, parameters, link sections, titled blocks).
// Split from DocMarkdown.swift to keep the enum body within the size/complexity gate.
extension DocMarkdown {
    // MARK: - Sections

    static func renderSection(_ section: SectionSpans, _ w: inout ByteWriter) {
        let kind = section.kind
        if spanEquals(kind, "abstract") {
            w.appendTrimmed(section.text)
            return
        }
        if spanEquals(kind, "declaration") {
            renderDeclaration(section, &w)
            return
        }
        if spanEquals(kind, "parameters") {
            renderParameters(section, &w)
            return
        }
        if spanEquals(kind, "discussion") {
            renderTitled(heading: section.heading, fallback: "Overview", text: section.text, &w)
            return
        }
        if spanEquals(kind, "topics") {
            renderLinkSection(title: "Topics", section, &w)
            return
        }
        if spanEquals(kind, "relationships") {
            renderLinkSection(title: "Relationships", section, &w)
            return
        }
        if spanEquals(kind, "see_also") {
            renderLinkSection(title: "See Also", section, &w)
            return
        }
        // default: empty trimmed text → no section; heading ?? humanize(kind).
        let textBytes = section.text.bindMemory(to: UInt8.self)
        let (ts, te) = ByteOps.trimRange(textBytes, 0, textBytes.count)
        if ts >= te { return }
        w.append("## ")
        if let heading = section.heading {
            w.append(span: heading)
        } else if let kind {
            w.append(JsString.humanize(String(decoding: kind.bindMemory(to: UInt8.self), as: UTF8.self)))
        } else {
            w.append("Section")
        }
        w.append("\n\n")
        w.appendNormalizedParagraphs(section.text)
    }

    static func spanEquals(_ span: ByteSpan?, _ literal: StaticString) -> Bool {
        guard let span, span.count == literal.utf8CodeUnitCount else { return false }
        if literal.utf8CodeUnitCount == 0 { return true }
        guard let base = span.baseAddress else { return false }
        return memcmp(base, literal.utf8Start, literal.utf8CodeUnitCount) == 0
    }

    /// renderTitledSection(title, normalizeParagraphs(text)) — empty body →
    /// no section at all.
    static func renderTitled(heading: ByteSpan?, fallback: StaticString, text: ByteSpan, _ w: inout ByteWriter) {
        w.append("## ")
        if let heading {
            w.append(span: heading)
        } else {
            w.append(fallback)
        }
        w.append("\n\n")
        let mark = w.count
        w.appendNormalizedParagraphs(text)
        if w.count == mark {
            w.removeAll()  // body empty → renderTitledSection returns ''
        }
    }

    static func renderDeclaration(_ section: SectionSpans, _ w: inout ByteWriter) {
        var blocks = ByteWriter(capacity: 256)
        var code = ByteWriter(capacity: 256)
        var blockCount = 0
        if let json = section.json, let doc = try? ADJSON.parse(json, options: .init(maxDepth: 64)), doc.root.isArray {
            doc.root.forEachElement { declaration in
                let obj = declaration.isObject ? declaration : nil
                code.removeAll()
                if let tokens = obj.flatMap({ $0.member("tokens") }), tokens.isArray {
                    tokens.forEachElement { token in
                        // `token.text ?? ''` — nullish only.
                        if token.isObject, let text = token.member("text"),
                            !text.isNull
                        {
                            code.appendCoercion(text)
                        }
                    }
                }
                // `if (!code.trim()) return null` — emptiness on the trimmed code.
                let (cs, ce) = ByteOps.trimRange(code.bytes, 0, code.bytes.count)
                if cs >= ce { return }
                if blockCount > 0 { blocks.append("\n\n") }
                blockCount += 1
                blocks.append("```")
                if let languages = obj.flatMap({ $0.member("languages") }),
                    let first = languages.firstElement, !first.isNull
                {
                    blocks.appendCoercion(first)
                } else {
                    blocks.append("swift")
                }
                blocks.append(0x0A)
                blocks.bytes.append(contentsOf: code.bytes)  // raw code, untrimmed
                blocks.append("\n```")
            }
        }
        if blockCount > 0 {
            w.append("## Declaration\n\n")
            w.bytes.append(contentsOf: blocks.bytes)
            return
        }
        let textBytes = section.text.bindMemory(to: UInt8.self)
        let (ts, te) = ByteOps.trimRange(textBytes, 0, textBytes.count)
        if ts >= te { return }
        w.append("## Declaration\n\n```swift\n")
        w.bytes.append(contentsOf: textBytes[ts ..< te])
        w.append("\n```")
    }

    static func renderParameters(_ section: SectionSpans, _ w: inout ByteWriter) {
        w.append("## Parameters\n")
        var wrote = false
        if let json = section.json, let doc = try? ADJSON.parse(json, options: .init(maxDepth: 64)), doc.root.isArray,
            doc.root.count > 0
        {
            doc.root.forEachElement { parameter in
                let obj = parameter.isObject ? parameter : nil
                w.append(0x0A)
                let lineMark = w.count
                w.append("- `")
                if let name = obj.flatMap({ $0.member("name") }), !name.isNull {
                    w.appendCoercion(name)
                } else {
                    w.append("Value")
                }
                w.append("`: ")
                let descMark = w.count
                ContentText.renderNodes(obj.flatMap { $0.member("content") }, refs: .none, into: &w)
                w.collapseWhitespace(since: descMark)
                w.trim(since: descMark)
                w.trim(since: lineMark)
                wrote = true
            }
        } else {
            let textBytes = section.text.bindMemory(to: UInt8.self)
            let (ts, te) = ByteOps.trimRange(textBytes, 0, textBytes.count)
            if ts < te {
                var lineStart = ts
                var i = ts
                while i <= te {
                    if i == te || textBytes[i] == 0x0A {
                        if i > lineStart {  // `.filter(Boolean)` drops empty lines
                            w.append("\n- ")
                            w.bytes.append(contentsOf: textBytes[lineStart ..< i])
                            wrote = true
                        }
                        lineStart = i + 1
                    }
                    i += 1
                }
            }
        }
        // lines.join('\n').trim() — with no items the bare "## Parameters\n"
        // trims to "## Parameters" (still a non-empty section).
        let (s, e) = ByteOps.trimRange(w.bytes, 0, w.bytes.count)
        if e < w.bytes.count { w.bytes.removeLast(w.bytes.count - e) }
        if s > 0 { w.bytes.removeSubrange(0 ..< s) }
        _ = wrote
    }

    static func renderLinkSection(title: StaticString, _ section: SectionSpans, _ w: inout ByteWriter) {
        w.append("## ")
        w.append(title)
        w.append(0x0A)
        var usedGroups = false
        if let json = section.json, let doc = try? ADJSON.parse(json, options: .init(maxDepth: 64)), doc.root.isArray,
            doc.root.count > 0
        {
            usedGroups = true
            doc.root.forEachElement { group in
                let obj = group.isObject ? group : nil
                if let groupTitle = obj.flatMap({ $0.member("title") }), groupTitle.isTruthy {
                    w.append("\n### ")
                    w.appendCoercion(groupTitle)
                    w.append(0x0A)
                }
                if let items = obj.flatMap({ $0.member("items") }), items.isArray {
                    items.forEachElement { item in
                        let itemObj = item.isObject ? item : nil
                        w.append(0x0A)
                        if let key = itemObj.flatMap({ $0.member("key") }), key.isTruthy {
                            w.append("- [")
                            if let itemTitle = itemObj.flatMap({ $0.member("title") }), !itemTitle.isNull {
                                w.appendCoercion(itemTitle)
                            } else {
                                w.appendCoercion(key)
                            }
                            w.append("](")
                            w.appendCoercion(key)
                            w.append(".md)")
                        } else {
                            let lineMark = w.count
                            w.append("- ")
                            if let itemTitle = itemObj.flatMap({ $0.member("title") }), !itemTitle.isNull {
                                w.appendCoercion(itemTitle)
                            } else if let identifier = itemObj.flatMap({ $0.member("identifier") }),
                                !identifier.isNull
                            {
                                w.appendCoercion(identifier)
                            }
                            w.trim(since: lineMark)
                        }
                    }
                }
                w.append(0x0A)  // the group's trailing '' line
            }
        }
        if !usedGroups {
            let textBytes = section.text.bindMemory(to: UInt8.self)
            let (ts, te) = ByteOps.trimRange(textBytes, 0, textBytes.count)
            if ts < te {
                var lineStart = ts
                var i = ts
                while i <= te {
                    if i == te || textBytes[i] == 0x0A {
                        if i > lineStart {
                            w.append("\n- ")
                            w.bytes.append(contentsOf: textBytes[lineStart ..< i])
                        }
                        lineStart = i + 1
                    }
                    i += 1
                }
            }
        }
        let (s, e) = ByteOps.trimRange(w.bytes, 0, w.bytes.count)
        if e < w.bytes.count { w.bytes.removeLast(w.bytes.count - e) }
        if s > 0 { w.bytes.removeSubrange(0 ..< s) }
    }
}
