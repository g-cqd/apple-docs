import AemiJSONCore
import AppleDocsContent
import AppleDocsCore
import Foundation
import OrderedCollections

extension PackagesAdapter {
    struct ReadmeInputs {
        let key: DocumentKey
        let owner: String
        let repo: String
        let readmeBytes: [UInt8]?
        let branch: String
        let filename: String?
        let etag: String?
    }

    static func makeOutcome(_ input: ReadmeInputs) -> SourceFetchOutcome {
        let fullName = "\(input.owner)/\(input.repo)"
        let pageURL = "https://github.com/\(fullName)"
        let markdownText = input.readmeBytes.map { String(decoding: $0, as: UTF8.self) }
        let abstractText = extractAbstract(markdownText) ?? "Package metadata imported from GitHub."
        let bodyBytes = input.readmeBytes ?? Array("# \(fullName)\n\n\(abstractText)\n".utf8)
        let base = MarkdownDocumentConverter.convert(
            markdown: bodyBytes,
            key: input.key,
            sourceType: .packages,
            fallbackTitle: fullName,
            url: pageURL
        )
        let sections = buildPackageSections(
            baseSections: base.sections,
            abstractText: abstractText,
            fullName: fullName,
            branch: input.branch,
            filename: input.filename
        )
        let sourceMeta = JSONValue.makeObject {
            ("package", .bool(true))
            ("source", .string("raw"))
            ("owner", .string(input.owner))
            ("repo", .string(input.repo))
            ("fullName", .string(fullName))
            ("defaultBranch", .string(input.branch))
        }
        let compositeETag = JSONValue.makeObject {
            ("source", .string("raw"))
            ("repo", .null)
            ("readme", input.etag.map(JSONValue.string) ?? .null)
            ("branch", .string(input.branch))
            ("readmeFilename", input.filename.map(JSONValue.string) ?? .null)
        }
        let doc = DocumentRecord(
            key: input.key,
            sourceType: .packages,
            title: base.document.title,
            kind: "package",
            role: "article",
            framework: rootSlug,
            url: pageURL,
            abstractText: abstractText,
            headings: base.document.headings,
            urlDepth: base.document.urlDepth,
            sourceMetadataJSON: JSONValue.jsonString(sourceMeta)
        )
        return .modified(
            payload: SourcePayload(converted: ConvertedDocument(document: doc, sections: sections)),
            etag: JSONValue.jsonString(compositeETag),
            discoveredKeys: []
        )
    }

    private static func buildPackageSections(
        baseSections: [DocumentSectionRecord],
        abstractText: String,
        fullName: String,
        branch: String,
        filename: String?
    ) -> [DocumentSectionRecord] {
        var sections = [
            DocumentSectionRecord(sectionKind: "abstract", heading: nil, contentText: abstractText, sortOrder: 0)
        ]
        for section in baseSections {
            sections.append(
                DocumentSectionRecord(
                    sectionKind: section.sectionKind,
                    heading: section.heading,
                    contentText: section.contentText,
                    contentJSON: section.contentJSON,
                    sortOrder: sections.count
                )
            )
        }
        var metaLines = ["Repository: \(fullName)", "Default branch: \(branch)"]
        if let filename { metaLines.append("README: \(filename)") }
        sections.append(
            DocumentSectionRecord(
                sectionKind: "discussion",
                heading: "Package Metadata",
                contentText: metaLines.joined(separator: "\n\n"),
                sortOrder: sections.count
            )
        )
        return sections
    }

    static func parseKey(_ key: DocumentKey) throws(SourceError) -> (String, String) {
        let parts = key.rawValue.split(separator: "/")
        guard parts.count == 3, parts[0] == rootSlug else {
            throw .unsafeURL(key.rawValue, reason: "Invalid packages key")
        }
        return (String(parts[1]), String(parts[2]))
    }

    static func parseGitHubRepoURL(_ raw: String) -> (owner: String, repo: String)? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let host = url.host?.lowercased(), host == "github.com" else {
            return nil
        }
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count >= 2 else { return nil }
        let owner = parts[0]
        var repo = parts[1]
        if repo.lowercased().hasSuffix(".git") {
            repo = String(repo.dropLast(4))
        }
        guard !owner.isEmpty, !repo.isEmpty else { return nil }
        return (owner, repo)
    }

    static func parseCompositeETag(
        _ raw: String?
    ) -> (readmeETag: String?, branch: String?, readmeFilename: String?) {
        guard let raw, let doc = try? AemiJSON.parse(Array(raw.utf8)) else { return (nil, nil, nil) }
        let root = doc.root
        return (root["readme"].string, root["branch"].string, root["readmeFilename"].string)
    }

    static func extractAbstract(_ markdown: String?) -> String? {
        guard let markdown else { return nil }
        var seenH1 = false
        for rawLine in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }
            if !seenH1 {
                if line.hasPrefix("# ") {
                    seenH1 = true
                    continue
                }
                if !line.hasPrefix("<"), !line.hasPrefix("[!["), !line.hasPrefix("![") {
                    return String(line.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(280))
                }
                continue
            }
            if line.hasPrefix("#") || line.hasPrefix("<") || line.hasPrefix("[![") || line.hasPrefix("![") { continue }
            return String(line.split(whereSeparator: \.isWhitespace).joined(separator: " ").prefix(280))
        }
        return nil
    }
}
