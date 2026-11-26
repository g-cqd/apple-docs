import AemiJSONCore
import Foundation

/// Bun's post-query filters (`search/filters.js` `matchesSearchFilters`), applied to every candidate record.
public struct SearchFilters: Sendable {
    public var frameworks: [String?]
    public var sourceTypes: Set<String>?
    public var kind: String?
    public var language: String?
    /// `minIos`… keyed by platform (`ios`, `macos`, `watchos`, `tvos`, `visionos`); `"0"` means "available at all".
    public var platformMinimums: [String: String]
    public var year: Int?
    public var track: String?
    public var deprecated: String

    private static let roleKindFilters: Set<String> = [
        "symbol", "article", "collection", "overview", "tutorial", "samplecode", "sample_code", "sample-project",
        "sampleproject"
    ]
    static let platformKeys = ["ios", "macos", "watchos", "tvos", "visionos"]

    func matches(_ record: SearchRecord, platforms: JSON?) -> Bool {
        matchesSource(record) && matchesFramework(record) && matchesKind(record) && matchesLanguage(record)
            && matchesPlatforms(record, platforms: platforms) && matchesMetadata(record) && matchesDeprecated(record)
    }

    private static func normalized(_ value: String?) -> String {
        (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func matchesSource(_ record: SearchRecord) -> Bool {
        guard let sourceTypes else { return true }
        return sourceTypes.contains((record.sourceType ?? "").lowercased())
    }

    private func matchesDeprecated(_ record: SearchRecord) -> Bool {
        switch deprecated {
            case "exclude": !record.isDeprecated
            case "only": record.isDeprecated
            default: true
        }
    }

    private func matchesFramework(_ record: SearchRecord) -> Bool {
        let candidates = frameworks.compactMap { $0 }.filter { !$0.isEmpty }.map(Self.normalized)
        guard !candidates.isEmpty else { return true }
        let values = [Self.normalized(record.rootSlug), Self.normalized(record.framework)].filter { !$0.isEmpty }
        return values.contains(where: candidates.contains)
    }

    private func matchesKind(_ record: SearchRecord) -> Bool {
        guard let kind else { return true }
        let target = Self.normalized(kind)
        guard !target.isEmpty else { return true }
        let displayed = Self.normalized(record.roleHeading)
        if kind != kind.lowercased() { return displayed == target }
        let roles = [record.role, record.docKind].map(Self.normalized).filter { !$0.isEmpty }
        if Self.roleKindFilters.contains(target) { return roles.contains(target) }
        return displayed == target
    }

    private func matchesLanguage(_ record: SearchRecord) -> Bool {
        guard let language else { return true }
        let value = Self.normalized(record.language)
        return value.isEmpty || value == Self.normalized(language) || value == "both"
    }

    private func matchesPlatforms(_ record: SearchRecord, platforms: JSON?) -> Bool {
        let explicit = [record.minIOS, record.minMacOS, record.minWatchOS, record.minTvOS, record.minVisionOS]
        for (index, key) in Self.platformKeys.enumerated() {
            guard let requested = platformMinimums[key], !requested.isEmpty else { continue }
            let actual = explicit[index] ?? platforms?[key].string
            if requested == "0" {
                if actual != nil { continue }
                guard let platforms else { continue }
                let keys =
                    platforms.object.map { Array($0.keys) } ?? platforms.array.map { $0.indices.map(String.init) } ?? []
                if keys.isEmpty || keys.contains(key) { continue }
                return false
            }
            if let actual, Self.compareVersions(actual, requested) > 0 { return false }
        }
        return true
    }

    private func matchesMetadata(_ record: SearchRecord) -> Bool {
        guard year != nil || track != nil else { return true }
        guard let raw = record.sourceMetadata, let metadata = try? AemiJSON.parse(Array(raw.utf8)).root,
            metadata.isObject
        else { return false }
        if let year, metadata["year"].int != year { return false }
        if let track {
            let value = Self.normalized(metadata["track"].string)
            if !value.contains(Self.normalized(track)) { return false }
        }
        return true
    }

    /// Numeric dotted-version comparison (`compareVersions`).
    static func compareVersions(_ left: String, _ right: String) -> Int {
        let lhs = versionParts(left)
        let rhs = versionParts(right)
        for index in 0 ..< max(lhs.count, rhs.count) {
            let difference = (index < lhs.count ? lhs[index] : 0) - (index < rhs.count ? rhs[index] : 0)
            if difference != 0 { return difference }
        }
        return 0
    }

    private static func versionParts(_ version: String) -> [Int] {
        version.split { !$0.isASCII || !$0.isNumber }.compactMap { Int($0) }
    }
}
