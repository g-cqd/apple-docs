import AemiJSONCore
public import AppleDocsCore

/// Renders a stored document as Markdown exactly like Bun's `content/render-markdown.js` (`read_doc` content on
/// installs without persisted Markdown files): YAML front matter, title, then each section by kind — abstract,
/// declaration code blocks, parameter bullets, titled discussions, and `[title](key.md)` link groups.
public enum BunMarkdownRenderer {
    /// The document fields the renderer reads.
    public struct Header: Sendable {
        public let key: String
        public let title: String?
        /// Root display name (Bun's `framework_display`), else the framework slug.
        public let framework: String?
        public let role: String?
        public let roleHeading: String?
        public let platformsJSON: String?

        public init(
            key: String,
            title: String?,
            framework: String?,
            role: String?,
            roleHeading: String?,
            platformsJSON: String?
        ) {
            self.key = key
            self.title = title
            self.framework = framework
            self.role = role
            self.roleHeading = roleHeading
            self.platformsJSON = platformsJSON
        }
    }

    /// `renderMarkdown(document, sections, { includeFrontMatter, includeTitle })`.
    public static func render(
        _ header: Header,
        sections: [DocumentSectionRecord],
        includeFrontMatter: Bool = true,
        includeTitle: Bool = true
    ) -> String {
        var parts: [String] = []
        if includeFrontMatter {
            parts.append(frontMatter(header))
            parts.append("")
        }
        if includeTitle, let title = header.title, !title.isEmpty {
            parts.append("# \(title)")
            parts.append("")
        }
        let ordered = sections.enumerated()
            .sorted { ($0.element.sortOrder, $0.offset) < ($1.element.sortOrder, $1.offset) }
        for (_, section) in ordered {
            let rendered = renderSection(section)
            if !rendered.isEmpty {
                parts.append(rendered)
                parts.append("")
            }
        }
        return DocCPlainText.trimmed(collapseBlankLines(parts.joined(separator: "\n"))) + "\n"
    }

    static func renderSection(_ section: DocumentSectionRecord) -> String {
        switch section.sectionKind {
            case "abstract": return DocCPlainText.trimmed(section.contentText)
            case "declaration": return declaration(section)
            case "parameters": return parameters(section)
            case "discussion": return titled(section.heading ?? "Overview", paragraphs(section.contentText))
            case "topics": return linkSection("Topics", section)
            case "relationships": return linkSection("Relationships", section)
            case "see_also": return linkSection("See Also", section)
            default:
                guard !DocCPlainText.trimmed(section.contentText).isEmpty else { return "" }
                return titled(section.heading ?? humanize(section.sectionKind), paragraphs(section.contentText))
        }
    }

    private static func declaration(_ section: DocumentSectionRecord) -> String {
        let blocks = (parsed(section.contentJSON)?.array ?? [])
            .compactMap { declaration -> String? in
                let code = (declaration["tokens"].array ?? []).map { $0["text"].string ?? "" }.joined()
                guard !DocCPlainText.trimmed(code).isEmpty else { return nil }
                let language = declaration["languages"][index: 0].string ?? "swift"
                return "```\(language)\n\(code)\n```"
            }
        if !blocks.isEmpty { return "## Declaration\n\n" + blocks.joined(separator: "\n\n") }
        let text = DocCPlainText.trimmed(section.contentText)
        return text.isEmpty ? "" : "## Declaration\n\n```swift\n\(text)\n```"
    }

    private static func parameters(_ section: DocumentSectionRecord) -> String {
        var lines = ["## Parameters", ""]
        if let parameters = parsed(section.contentJSON)?.array, !parameters.isEmpty {
            let noRefs = parameters[0]["__no_references__"]  // Bun renders parameters with an empty refs map
            for parameter in parameters {
                let description = DocCPlainText.trimmed(
                    collapseWhitespace(DocCPlainText.blocks(parameter["content"], refs: noRefs))
                )
                lines.append(DocCPlainText.trimmed("- `\(parameter["name"].string ?? "Value")`: \(description)"))
            }
        } else {
            lines += bulletLines(section.contentText)
        }
        return DocCPlainText.trimmed(lines.joined(separator: "\n"))
    }

    private static func linkSection(_ title: String, _ section: DocumentSectionRecord) -> String {
        var lines = ["## \(title)", ""]
        if let groups = parsed(section.contentJSON)?.array, !groups.isEmpty {
            for group in groups {
                if let groupTitle = group["title"].string, !groupTitle.isEmpty {
                    lines += ["### \(groupTitle)", ""]
                }
                for item in group["items"].array ?? [] {
                    if let key = item["key"].string, !key.isEmpty {
                        lines.append("- [\(item["title"].string ?? key)](\(key).md)")
                    } else {
                        lines.append(
                            DocCPlainText.trimmed("- \(item["title"].string ?? item["identifier"].string ?? "")")
                        )
                    }
                }
                lines.append("")
            }
            return DocCPlainText.trimmed(lines.joined(separator: "\n"))
        }
        lines += bulletLines(section.contentText)
        return DocCPlainText.trimmed(lines.joined(separator: "\n"))
    }

    private static func bulletLines(_ text: String) -> [String] {
        DocCPlainText.trimmed(text).split(separator: "\n").filter { !$0.isEmpty }.map { "- \($0)" }
    }

    private static func titled(_ title: String, _ body: String) -> String {
        body.isEmpty ? "" : "## \(title)\n\n\(body)"
    }

    /// `normalizeParagraphs`: paragraphs split on blank lines, inner newlines folded to spaces.
    static func paragraphs(_ text: String) -> String {
        let trimmed = DocCPlainText.trimmed(text)
        guard !trimmed.isEmpty else { return "" }
        var paragraphs: [String] = []
        var current: [Substring] = []
        var blankRun = 0
        for line in trimmed.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.isEmpty {
                blankRun += 1
                continue
            }
            if blankRun >= 1, !current.isEmpty {
                paragraphs.append(current.joined(separator: " "))
                current = []
            }
            blankRun = 0
            current.append(line)
        }
        if !current.isEmpty { paragraphs.append(current.joined(separator: " ")) }
        return paragraphs.map(DocCPlainText.trimmed).joined(separator: "\n\n")
    }

    private static func parsed(_ json: String?) -> JSON? {
        guard let json, let root = try? AemiJSON.parse(Array(json.utf8)).root else { return nil }
        return root
    }
}
