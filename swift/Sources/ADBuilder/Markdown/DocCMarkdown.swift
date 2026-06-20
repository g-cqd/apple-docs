// DocCMarkdown — DocC-flavored Markdown helpers shared by the Markdown adapters
// (swift-book, swift-org, …). Reads DocC `<doc:Name>` symbol references and the
// `## Topics` / `### Group` / `- <doc:Name>` curation structure. Built on the
// swift-markdown AST (a `<doc:Name>` autolink parses to a Link with a `doc:` scheme),
// so it's robust where the JS regex (`<doc:([A-Za-z0-9_-]+)>`) scanned raw text.
import Markdown

public enum DocCMarkdown {
    /// One curated topic group: a `### Group` heading + its `<doc:Name>` items
    /// (the reference names, `doc:` stripped), in document order.
    public struct TopicGroup: Sendable, Equatable {
        public var title: String
        public var items: [String]
        public init(title: String, items: [String]) {
            self.title = title
            self.items = items
        }
    }

    /// Every `<doc:Name>` reference in `markdown`, in document order.
    public static func docReferences(in markdown: String) -> [String] {
        var references: [String] = []
        collectDocLinks(Document(parsing: markdown), into: &references)
        return references
    }

    /// Parse the DocC `## Topics` curation: each `### Group` under `## Topics`, with
    /// its `<doc:Name>` items. Groups without items are dropped (the JS contract).
    public static func parseTopics(_ markdown: String) -> [TopicGroup] {
        let document = Document(parsing: markdown)
        var groups: [TopicGroup] = []
        var inTopics = false
        var currentTitle: String?
        var currentItems: [String] = []

        func flush() {
            if let title = currentTitle, !currentItems.isEmpty {
                groups.append(TopicGroup(title: title, items: currentItems))
            }
            currentTitle = nil
            currentItems = []
        }

        for child in document.children {
            if let heading = child as? Heading {
                if heading.level <= 2 {
                    flush()
                    inTopics = heading.level == 2 && trimmed(heading.plainText) == "Topics"
                    continue
                }
                if heading.level == 3, inTopics {
                    flush()
                    currentTitle = trimmed(heading.plainText)
                    continue
                }
            }
            if inTopics, currentTitle != nil {
                collectDocLinks(child, into: &currentItems)
            }
        }
        flush()
        return groups
    }

    private static func collectDocLinks(_ markup: any Markup, into references: inout [String]) {
        if let link = markup as? Link, let destination = link.destination, destination.hasPrefix("doc:") {
            references.append(String(destination.dropFirst("doc:".count)))
        }
        for child in markup.children { collectDocLinks(child, into: &references) }
    }

    private static func trimmed(_ text: String) -> String {
        String(text.drop(while: \.isWhitespace).reversed().drop(while: \.isWhitespace).reversed())
    }
}
