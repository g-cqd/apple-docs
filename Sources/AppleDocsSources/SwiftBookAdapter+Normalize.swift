import AemiJSONCore
import AppleDocsContent
import AppleDocsCore
import Foundation
import OrderedCollections
import Synchronization

extension SwiftBookAdapter {
    func normalize(
        key: DocumentKey,
        relativePath: String,
        markdownBytes: [UInt8],
        markdown: String
    ) -> ConvertedDocument {
        let basename = relativePath.split(separator: "/").last.map(String.init) ?? key.rawValue
        let isRoot = basename.lowercased() == Self.rootFile
        let pageURL =
            isRoot
            ? "https://docs.swift.org/swift-book/documentation/the-swift-programming-language/"
            : "https://docs.swift.org/swift-book/documentation/the-swift-programming-language/\(basename.lowercased())"
        let base = MarkdownDocumentConverter.convert(
            markdown: markdownBytes,
            key: key,
            sourceType: .swiftBook,
            fallbackTitle: Self.humanize(basename),
            url: pageURL
        )
        var sections = base.sections
        var relationships: [DocumentRelationshipRecord] = []
        var sourceMetadata: String?

        if isRoot {
            applyRootTopics(markdown: markdown, rootKey: key, sections: &sections, relationships: &relationships)
        } else if let dir = relativePath.split(separator: "/").first.map(String.init),
            relativePath.contains("/"),
            let sectionTitle = Self.sectionTitles[dir.lowercased()]
        {
            sourceMetadata = JSONValue.jsonString(
                JSONValue.makeObject {
                    ("bookSection", .string(sectionTitle))
                    ("bookSectionDir", .string(dir))
                }
            )
        }

        let doc = DocumentRecord(
            key: key,
            sourceType: .swiftBook,
            title: base.document.title,
            kind: isRoot ? "collection" : "book-chapter",
            role: isRoot ? "collection" : "article",
            framework: Self.rootSlug,
            url: pageURL,
            abstractText: base.document.abstractText,
            headings: base.document.headings,
            urlDepth: base.document.urlDepth,
            sourceMetadataJSON: sourceMetadata
        )
        return ConvertedDocument(document: doc, sections: sections, relationships: relationships)
    }

    private func applyRootTopics(
        markdown: String,
        rootKey: DocumentKey,
        sections: inout [DocumentSectionRecord],
        relationships: inout [DocumentRelationshipRecord]
    ) {
        let chapters = state.withLock { $0.chapterKeysByName }
        let groups = Self.parseBookTopics(markdown)
        guard !groups.isEmpty else { return }
        sections.removeAll { $0.sectionKind == "discussion" && $0.heading == "Topics" }
        let nextOrder = (sections.map(\.sortOrder).max() ?? -1) + 1
        let jsonGroups: [JSONValue] = groups.map { group in
            let items: [JSONValue] = group.items.map { name in
                let resolved = chapters[name.lowercased()]
                return JSONValue.makeObject {
                    ("identifier", .string("swift-book://\(name)"))
                    ("key", resolved.map { .string($0.rawValue) } ?? .null)
                    ("title", .string(Self.humanize(name)))
                }
            }
            return JSONValue.makeObject {
                ("title", .string(group.title))
                ("type", .null)
                ("items", .array(items))
            }
        }
        let text =
            groups
            .map { ([$0.title] + $0.items.map(Self.humanize)).joined(separator: "\n") }
            .joined(separator: "\n")
        sections.append(
            DocumentSectionRecord(
                sectionKind: "topics",
                heading: "Topics",
                contentText: text,
                contentJSON: JSONValue.jsonString(.array(jsonGroups)),
                sortOrder: nextOrder
            )
        )
        var relOrder = 0
        for group in groups {
            for name in group.items {
                guard let target = chapters[name.lowercased()] else { continue }
                relationships.append(
                    DocumentRelationshipRecord(
                        fromKey: rootKey,
                        toKey: target,
                        relationType: "child",
                        section: group.title,
                        sortOrder: relOrder
                    )
                )
                relOrder += 1
            }
        }
    }

    static func parseBookTopics(_ markdown: String) -> [(title: String, items: [String])] {
        var inTopics = false
        var currentGroup: String?
        var currentItems: [String] = []
        var groups: [(title: String, items: [String])] = []

        func flush() {
            if let title = currentGroup, !currentItems.isEmpty {
                groups.append((title, currentItems))
            }
            currentItems = []
        }

        for rawLine in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("## ") {
                flush()
                currentGroup = nil
                inTopics = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces) == "Topics"
                continue
            }
            guard inTopics else { continue }
            if line.hasPrefix("### ") {
                flush()
                currentGroup = String(line.dropFirst(4)).trimmingCharacters(in: .whitespaces)
                continue
            }
            if let docRange = line.range(of: "<doc:"),
                let close = line[docRange.upperBound...].firstIndex(of: ">")
            {
                let name = String(line[docRange.upperBound ..< close])
                if !name.isEmpty { currentItems.append(name) }
            }
        }
        flush()
        return groups
    }

    static func humanize(_ name: String) -> String {
        var out = ""
        let chars = Array(name)
        for idx in chars.indices {
            let ch = chars[idx]
            if idx > 0, ch.isUppercase {
                let prev = chars[idx - 1]
                let nextLower = idx + 1 < chars.count && chars[idx + 1].isLowercase
                if prev.isLowercase || (prev.isUppercase && nextLower) {
                    out.append(" ")
                }
            }
            out.append(ch)
        }
        return out
    }
}
