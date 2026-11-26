import AemiJSONCore
import AppleDocsCore
import Foundation
import OrderedCollections

extension SwiftOrgAdapter {
    // @dl:disable -- curated swift.org HTML documentation path inventory
    public static let curatedPaths: [String] = [
        "documentation",
        "documentation/api-design-guidelines",
        "documentation/standard-library",
        "documentation/core-libraries",
        "documentation/cxx-interop",
        "documentation/docc",
        "documentation/server",
        "documentation/swift-compiler",
        "documentation/lldb",
        "documentation/tspl",
        "documentation/continuous-integration",
        "documentation/source-code",
        "documentation/source-compatibility",
        "documentation/monthly-non-darwin-release",
        "documentation/server/guides/allocations.html",
        "documentation/server/guides/building.html",
        "documentation/server/guides/deployment.html",
        "documentation/server/guides/llvm-sanitizers.html",
        "documentation/server/guides/memory-leaks-and-usage.html",
        "documentation/server/guides/packaging.html",
        "documentation/server/guides/passkeys.html",
        "documentation/server/guides/performance.html",
        "documentation/server/guides/testing.html",
        "documentation/server/guides/libraries/concurrency-adoption-guidelines.html",
        "documentation/server/guides/libraries/log-levels.html",
        "documentation/articles/value-and-reference-types.html",
        "documentation/articles/getting-started-with-vscode-swift.html",
        "documentation/articles/getting-started-with-cursor-swift.html",
        "documentation/articles/static-linux-getting-started.html",
        "documentation/articles/swift-sdk-for-android-getting-started.html",
        "documentation/articles/wasm-getting-started.html",
        "documentation/articles/zero-to-swift-emacs.html",
        "documentation/articles/zero-to-swift-nvim.html",
        "documentation/articles/wrapping-c-cpp-library-in-swift.html",
        "getting-started",
        "getting-started/cli-swiftpm",
        "getting-started/library-swiftpm",
        "getting-started/swiftui",
        "getting-started/vapor-web-server",
        "install",
        "install/linux",
        "install/macos",
        "install/windows",
        "community",
        "community/how-we-work",
        "contributing",
        "about",
        "platform-support",
        "code-of-conduct",
        "diversity",
        "mentorship",
        "packages",
        "sswg",
        "sswg/incubation-process.html",
        "support/security.html",
        "openapi"
    ]
    // @dl:enable

    static let crossLinks: [CrossLink] = {
        var list = SwiftDocCAdapter.archives.map { archive in
            CrossLink(
                key: archive.entryKey,
                title: archive.entryTitle,
                summary: archive.entrySummary,
                parents: Set(archive.parents)
            )
        }
        list.append(
            CrossLink(
                key: "swift-book/the-swift-programming-language",
                title: "The Swift Programming Language",
                summary: "The canonical Swift language guide and reference manual.",
                parents: ["swift-org/documentation", "swift-org/documentation/tspl"]
            )
        )
        return list
    }()

    static func appendCrossLinks(
        for key: DocumentKey,
        sections: inout [DocumentSectionRecord],
        relationships: inout [DocumentRelationshipRecord]
    ) {
        let matchingLinks = crossLinks.filter { $0.parents.contains(key.rawValue) }
        guard !matchingLinks.isEmpty else { return }
        let order = (sections.map(\.sortOrder).max() ?? -1) + 1
        let items: [JSONValue] = matchingLinks.map { link in
            let abstractNode = JSONValue.makeObject {
                ("type", .string("text"))
                ("text", .string(link.summary))
            }
            return JSONValue.makeObject {
                ("identifier", .string(link.key))
                ("key", .string(link.key))
                ("title", .string(link.title))
                ("abstract", .array([abstractNode]))
            }
        }
        let group = JSONValue.makeObject {
            ("title", .string("Related Documentation"))
            ("type", .null)
            ("items", .array(items))
        }
        let text = matchingLinks.map { "\($0.title): \($0.summary)" }.joined(separator: "\n")
        sections.append(
            DocumentSectionRecord(
                sectionKind: "topics",
                heading: "Related Documentation",
                contentText: text,
                contentJSON: JSONValue.jsonString(.array([group])),
                sortOrder: order
            )
        )
        for (idx, link) in matchingLinks.enumerated() {
            if let target = try? DocumentKey(link.key) {
                relationships.append(
                    DocumentRelationshipRecord(
                        fromKey: key,
                        toKey: target,
                        relationType: "see_also",
                        section: "Related Documentation",
                        sortOrder: idx
                    )
                )
            }
        }
    }

    static func stripBrandSuffix(_ title: String) -> String {
        for sep in [" | Swift.org", " - Swift.org", " — Swift.org"] {
            if let range = title.range(of: sep, options: [.caseInsensitive, .backwards]),
                range.upperBound == title.endIndex
            {
                let trimmed = String(title[..<range.lowerBound]).trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return title
    }
}
