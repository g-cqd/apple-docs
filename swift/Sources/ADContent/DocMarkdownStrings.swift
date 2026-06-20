// A `String`-backed entry point to `DocMarkdown.render` for in-process callers
// (the ad-server read_doc handler) that hold Swift values rather than the FFI
// request buffer. The span renderer requires every nullable field to be a
// `ByteSpan` over a buffer that outlives the render; this adapter copies the
// document + section strings into ONE contiguous byte arena, builds spans that
// rebase into it, and runs `DocMarkdown.render` inside a single
// `withUnsafeBytes` so all spans stay valid. The field coercions mirror
// ContentExports.adContentDocMarkdown / render-markdown.js coerceDocument /
// coerceSection exactly (nullable kind/heading/json, contentText defaulting to
// "", sortOrder defaulting to 0), so the bytes match the JS oracle.

/// The document fields `renderMarkdown(document, sections)` consumes, as Swift
/// strings (nil = JS null/undefined). Mirrors `DocFieldSpans`.
public struct DocMarkdownDocument: Sendable {
    public var key: String?
    public var title: String?
    public var framework: String?
    public var frameworkDisplay: String?
    public var role: String?
    public var roleHeading: String?
    public var platformsJSON: String?

    public init(
        key: String? = nil, title: String? = nil, framework: String? = nil,
        frameworkDisplay: String? = nil, role: String? = nil, roleHeading: String? = nil,
        platformsJSON: String? = nil
    ) {
        self.key = key
        self.title = title
        self.framework = framework
        self.frameworkDisplay = frameworkDisplay
        self.role = role
        self.roleHeading = roleHeading
        self.platformsJSON = platformsJSON
    }
}

/// One section as `renderMarkdown` consumes it (mirrors `SectionSpans`).
/// `contentText` is coerced to "" by the caller when the column is null, exactly
/// like coerceSection's `?? ''`.
public struct DocMarkdownSection: Sendable {
    public var kind: String?
    public var heading: String?
    public var contentText: String
    public var contentJSON: String?
    public var sortOrder: Double

    public init(
        kind: String? = nil, heading: String? = nil, contentText: String = "",
        contentJSON: String? = nil, sortOrder: Double = 0
    ) {
        self.kind = kind
        self.heading = heading
        self.contentText = contentText
        self.contentJSON = contentJSON
        self.sortOrder = sortOrder
    }
}

extension DocMarkdown {
    /// `renderMarkdown(document, sections, { includeFrontMatter, includeTitle })`
    /// over Swift values. Returns the rendered Markdown string (UTF-8 decoded
    /// from the same bytes `DocMarkdown.render` produces for the FFI path).
    public static func render(
        document: DocMarkdownDocument, sections: [DocMarkdownSection],
        includeFrontMatter: Bool = true, includeTitle: Bool = true
    ) -> String {
        // Arena layout: each field's UTF-8 appended once; a (offset,length,present)
        // record per field. `present == false` → nil span; otherwise a span that
        // rebases into the arena (empty strings stay non-nil zero-length spans,
        // distinct from null, matching the JS '' vs null distinction).
        struct Slot {
            var offset: Int
            var length: Int
            var present: Bool
        }

        var arena: [UInt8] = []
        func reserve(_ value: String?) -> Slot {
            guard var value else { return Slot(offset: arena.count, length: 0, present: false) }
            let offset = arena.count
            value.withUTF8 { arena.append(contentsOf: $0) }
            return Slot(offset: offset, length: arena.count - offset, present: true)
        }

        let keySlot = reserve(document.key)
        let titleSlot = reserve(document.title)
        let frameworkSlot = reserve(document.framework)
        let frameworkDisplaySlot = reserve(document.frameworkDisplay)
        let roleSlot = reserve(document.role)
        let roleHeadingSlot = reserve(document.roleHeading)
        let platformsSlot = reserve(document.platformsJSON)

        struct SectionSlots {
            var kind: Slot
            var heading: Slot
            var text: Slot
            var json: Slot
            var sortOrder: Double
        }
        var sectionSlots: [SectionSlots] = []
        sectionSlots.reserveCapacity(sections.count)
        for section in sections {
            sectionSlots.append(
                SectionSlots(
                    kind: reserve(section.kind), heading: reserve(section.heading),
                    text: reserve(section.contentText), json: reserve(section.contentJSON),
                    sortOrder: section.sortOrder))
        }

        var out: [UInt8] = []
        arena.withUnsafeBytes { raw in
            func span(_ slot: Slot) -> ByteSpan? {
                guard slot.present else { return nil }
                return ByteSpan(rebasing: raw[slot.offset ..< slot.offset + slot.length])
            }
            let empty = ByteSpan(start: nil, count: 0)
            let docSpans = DocFieldSpans(
                key: span(keySlot), title: span(titleSlot), framework: span(frameworkSlot),
                frameworkDisplay: span(frameworkDisplaySlot), role: span(roleSlot),
                roleHeading: span(roleHeadingSlot), platformsJson: span(platformsSlot))
            let sectionSpans = sectionSlots.map { slots in
                SectionSpans(
                    kind: span(slots.kind), heading: span(slots.heading),
                    text: span(slots.text) ?? empty, json: span(slots.json),
                    sortOrder: slots.sortOrder)
            }
            var w = ByteWriter(capacity: 4096)
            var sectionW = ByteWriter(capacity: 2048)
            DocMarkdown.render(
                document: docSpans, sections: sectionSpans,
                options: .init(includeFrontMatter: includeFrontMatter, includeTitle: includeTitle),
                w: &w, sectionW: &sectionW, out: &out)
        }
        return String(decoding: out, as: UTF8.self)
    }
}
