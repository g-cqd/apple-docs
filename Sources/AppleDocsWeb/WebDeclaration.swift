import AemiJSONCore
import AppleDocsCore

/// One language variant of a page's declaration (from the stored `declaration` section's token list).
public struct WebDeclaration: Hashable, Sendable {
    public let language: String
    public let code: String

    /// The declaration variants stored in `sections` (Bun shape: `[{languages, tokens}]`), first language wins.
    static func variants(in sections: [DocumentSectionRecord]) -> [WebDeclaration] {
        guard let json = sections.first(where: { $0.sectionKind == "declaration" })?.contentJSON,
            let root = try? AemiJSON.parse(Array(json.utf8)).root, let items = root.array
        else { return [] }
        var seen: Set<String> = []
        return items.compactMap { item in
            let code = (item["tokens"].array ?? []).map { $0["text"].string ?? "" }.joined()
            let language = item["languages"][index: 0].string ?? "swift"
            guard !code.allSatisfy(\.isWhitespace), seen.insert(language).inserted else { return nil }
            return WebDeclaration(language: language, code: code)
        }
    }
}
