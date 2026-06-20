import ADJSONCore

/// Nullable byte spans over the request buffer (nil = JS null/undefined).
public struct DocFieldSpans {
    public var key: ByteSpan?
    public var title: ByteSpan?
    public var framework: ByteSpan?
    public var frameworkDisplay: ByteSpan?
    public var role: ByteSpan?
    public var roleHeading: ByteSpan?
    public var platformsJson: ByteSpan?

    public init(
        key: ByteSpan? = nil, title: ByteSpan? = nil, framework: ByteSpan? = nil,
        frameworkDisplay: ByteSpan? = nil, role: ByteSpan? = nil, roleHeading: ByteSpan? = nil,
        platformsJson: ByteSpan? = nil
    ) {
        self.key = key
        self.title = title
        self.framework = framework
        self.frameworkDisplay = frameworkDisplay
        self.role = role
        self.roleHeading = roleHeading
        self.platformsJson = platformsJson
    }
}

public struct SectionSpans {
    public var kind: ByteSpan?
    public var heading: ByteSpan?
    public var text: ByteSpan  // contentText (coerced default '')
    public var json: ByteSpan?
    public var sortOrder: Double

    public init(
        kind: ByteSpan? = nil, heading: ByteSpan? = nil, text: ByteSpan, json: ByteSpan? = nil,
        sortOrder: Double = 0
    ) {
        self.kind = kind
        self.heading = heading
        self.text = text
        self.json = json
        self.sortOrder = sortOrder
    }
}

public enum DocMarkdown {
    /// Whether the render includes the YAML front matter and/or the `# title` heading.
    public struct RenderOptions {
        public let includeFrontMatter: Bool
        public let includeTitle: Bool
        public init(includeFrontMatter: Bool, includeTitle: Bool) {
            self.includeFrontMatter = includeFrontMatter
            self.includeTitle = includeTitle
        }
    }

    /// Renders the finished document bytes into `out` (reusing `w` and
    /// `sectionW` as scratch).
    public static func render(
        document: DocFieldSpans, sections: [SectionSpans], options: RenderOptions,
        w: inout ByteWriter, sectionW: inout ByteWriter, out: inout [UInt8]
    ) {
        w.removeAll()
        var parts = PartsWriter()

        if options.includeFrontMatter {
            parts.begin(&w)
            frontMatter(document, &w)
            parts.begin(&w)
        }
        if options.includeTitle, let title = document.title, !title.isEmpty {
            parts.begin(&w)
            w.append("# ")
            w.append(span: title)
            parts.begin(&w)
        }

        // Stable sort by (sortOrder, original index) — JS Array.sort is stable.
        let order = sections.indices.sorted {
            sections[$0].sortOrder != sections[$1].sortOrder
                ? sections[$0].sortOrder < sections[$1].sortOrder
                : $0 < $1
        }
        for index in order {
            sectionW.removeAll()
            renderSection(sections[index], &sectionW)
            if sectionW.count > 0 {
                parts.begin(&w)
                w.bytes.append(contentsOf: sectionW.bytes)
                parts.begin(&w)
            }
        }

        ByteOps.finishDocument(w.bytes, into: &out, trailingNewline: true)
    }

    // MARK: - Front matter

    static func frontMatter(_ doc: DocFieldSpans, _ w: inout ByteWriter) {
        w.append("---")
        func field(_ name: StaticString, _ span: ByteSpan?) {
            guard let span else { return }
            w.append(0x0A)
            w.append(name)
            w.append(": ")
            appendQuoted(span: span, &w)
        }
        field("title", doc.title)
        field("framework", doc.frameworkDisplay ?? doc.framework)
        field("role", doc.role)
        field("role_heading", doc.roleHeading)
        appendPlatforms(doc.platformsJson, &w)
        field("path", doc.key)
        w.append("\n---")
    }

    /// formatPlatforms: array → element coercions; object → "Name version+"
    /// in insertion order; anything else → field skipped entirely.
    static func appendPlatforms(_ platformsJson: ByteSpan?, _ w: inout ByteWriter) {
        guard let json = platformsJson, let doc = try? ADJSON.parse(json, options: .init(maxDepth: 64)) else { return }
        let root = doc.root
        var items = ByteWriter(capacity: 128)
        var first = true
        func appendItem(_ body: (inout ByteWriter) -> Void) {
            var item = ByteWriter(capacity: 48)
            body(&item)
            if !first { items.append(", ") }
            first = false
            appendQuotedBytes(item.bytes, &items)
        }
        if root.isArray {
            root.forEachElement { element in
                appendItem { item in item.appendCoercion(element) }
            }
        } else if root.isObject {
            root.forEachMember { key, value in
                appendItem { item in
                    appendPrettyPlatform(key, &item)
                    if value.isTruthy {
                        item.append(0x20)
                        item.appendCoercion(value)
                        item.append(0x2B)
                    }
                }
            }
        } else {
            return
        }
        w.append("\nplatforms: [")
        w.bytes.append(contentsOf: items.bytes)
        w.append(0x5D)
    }

    static func appendPrettyPlatform(_ key: String, _ w: inout ByteWriter) {
        let pretty: [(String, StaticString)] = [
            ("ios", "iOS"), ("macos", "macOS"), ("watchos", "watchOS"), ("tvos", "tvOS"),
            ("visionos", "visionOS"), ("maccatalyst", "Mac Catalyst"), ("ipados", "iPadOS")
        ]
        for (raw, display) in pretty where key == raw {
            w.append(display)
            return
        }
        w.append(key)
    }

    static func appendQuoted(span: ByteSpan, _ w: inout ByteWriter) {
        let bytes = span.bindMemory(to: UInt8.self)
        if FrontMatter.needsQuotingBytes(bytes) {
            w.append(0x22)
            for byte in bytes {
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
            w.bytes.append(contentsOf: bytes)
        }
    }

    static func appendQuotedBytes(_ bytes: [UInt8], _ w: inout ByteWriter) {
        bytes.withUnsafeBytes { appendQuoted(span: ByteSpan($0), &w) }
    }

}

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif
