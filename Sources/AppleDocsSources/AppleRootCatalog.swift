import AemiJSONCore
import AppleDocsContent
public import AppleDocsCore

/// The documentation roots Apple publishes, from its technologies index — a port of Bun's `discoverRoots`
/// (`pipeline/discover.js`): one root per technology (kind from its group), plus the Human Interface Guidelines and
/// App Store Review Guidelines roots, which the index does not list.
public enum AppleRootCatalog {
    public static let technologiesURL = "https://developer.apple.com/tutorials/data/documentation/technologies.json"

    /// Bun's `KIND_MAP` (group name → root kind; others are `unknown`).
    static func kind(forGroup name: String?) -> String {
        switch name {
            case "App Frameworks", "App Services", "Graphics and Games", "Media", "System", "Web": "framework"
            case "Developer Tools": "tooling"
            case "Release Notes": "release-notes"
            case "Design", "Technology Overviews": "technology"
            case "Sample Code": "tutorial"
            default: "unknown"
        }
    }

    /// Bun's `deriveRootSourceType(slug, kind)` (`ROOT_SOURCE_TYPE_BY_SLUG`, then the kind, then Apple DocC).
    static func sourceType(slug: String, kind: String) -> SourceKind {
        switch slug {
            case "app-store-review": return .guidelines
            case "design": return .hig
            case "apple-archive": return .appleArchive
            case "packages": return .packages
            case "sample-code": return .sampleCode
            case "swift-book": return .swiftBook
            case "swift-evolution": return .swiftEvolution
            case "swift-org": return .swiftOrg
            case "wwdc": return .wwdc
            default: break
        }
        if kind == "guidelines" { return .guidelines }
        if kind == "design" { return .hig }
        return .appleDocC
    }

    /// Fetches and parses the technologies index.
    public static func fetch(client: UpstreamHTTPClient) async throws(SourceError) -> [CorpusRootRecord] {
        let response = try await client.get(url: technologiesURL)
        guard response.statusCode == 200 else { throw .httpStatus(response.statusCode, url: technologiesURL) }
        return try roots(fromTechnologies: response.body)
    }

    /// Roots in Bun's upsert order (a slug listed twice appears twice; the store applies them in sequence).
    public static func roots(fromTechnologies bytes: [UInt8]) throws(SourceError) -> [CorpusRootRecord] {
        guard let root = try? AemiJSON.parse(bytes).root, root.isObject else {
            throw .malformedPayload(url: technologiesURL, reason: "not a JSON object")
        }
        var roots: [CorpusRootRecord] = []
        for section in root["sections"].array ?? [] {
            for group in section["groups"].array ?? [] {
                let kind = kind(forGroup: group["name"].string)
                for technology in group["technologies"].array ?? [] {
                    guard let identifier = technology["destination"]["identifier"].string,
                        let path = AppleIdentifier.normalize(identifier),
                        let slug = path.split(separator: "/", maxSplits: 1).first.map(String.init), !slug.isEmpty
                    else { continue }
                    roots.append(
                        CorpusRootRecord(
                            slug: slug,
                            displayName: technology["title"].string ?? slug,
                            kind: kind,
                            sourceType: sourceType(slug: slug, kind: kind)
                        )
                    )
                }
            }
        }
        roots.append(
            CorpusRootRecord(
                slug: "design",
                displayName: "Human Interface Guidelines",
                kind: "design",
                sourceType: .hig,
                seedPath: "design/human-interface-guidelines"
            )
        )
        roots.append(
            CorpusRootRecord(
                slug: "app-store-review",
                displayName: "App Store Review Guidelines",
                kind: "guidelines",
                sourceType: .guidelines
            )
        )
        return roots
    }
}
