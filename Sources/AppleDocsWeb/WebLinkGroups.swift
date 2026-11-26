import AppleDocsOutput

/// A page's outgoing relationships bucketed into the sections they render under (topics, see also,
/// relationships) and grouped by their source group title, each bucket consumable once.
struct WebLinkGroups {
    /// The page section a relationship renders under.
    enum Category: CaseIterable {
        case topics, seeAlso, relationships

        init(relationType: String) {
            switch relationType {
                case "child": self = .topics
                case "see_also": self = .seeAlso
                default: self = .relationships
            }
        }

        init?(sectionKind: String) {
            switch sectionKind {
                case "topics": self = .topics
                case "see_also": self = .seeAlso
                case "relationships": self = .relationships
                default: return nil
            }
        }

        var defaultHeading: String {
            switch self {
                case .topics: "Topics"
                case .seeAlso: "See Also"
                case .relationships: "Relationships"
            }
        }
    }

    private var buckets: [Category: [(title: String?, items: [PublicRelatedDocument])]] = [:]

    init(_ related: [PublicRelatedDocument]) {
        for item in related {
            let category = Category(relationType: item.relationType)
            let title =
                item.section.flatMap { $0.isEmpty ? nil : $0 } ?? (category == .relationships ? item.groupTitle : nil)
            var groups = buckets[category, default: []]
            if let index = groups.lastIndex(where: { $0.title == title }) {
                groups[index].items.append(item)
            } else {
                groups.append((title, [item]))
            }
            buckets[category] = groups
        }
    }

    func has(_ category: Category) -> Bool {
        !(buckets[category] ?? []).isEmpty
    }

    /// The category's groups, removed so a later fallback section does not repeat them.
    mutating func take(_ category: Category) -> [(title: String?, items: [PublicRelatedDocument])] {
        buckets.removeValue(forKey: category) ?? []
    }
}
