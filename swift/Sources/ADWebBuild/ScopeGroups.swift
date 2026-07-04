// ScopeGroups — scope-aware grouping for framework listing pages (port of
// src/web/templates/framework-groups.js + scope-groups-extra.js + the
// higGroups shape from scope-group-data.js). Non-framework roots (WWDC,
// Swift Evolution, sample code, guidelines, release notes, the Swift book,
// packages, technotes, the archive, HIG) get curated sections instead of the
// generic role buckets; `buildScopeGroups` returns nil for everything else
// (→ the role-grouping fallback).
//
// SORT-PARITY NOTES:
// - Every `.sort()` here is a JS STABLE sort — ported via `stableSorted`
//   (index-decorated), so ties keep input order like the JS.
// - `byTitle` is `String.prototype.localeCompare` (ICU). The port uses
//   Foundation's locale-aware compare under en_US — flagged for the
//   real-corpus pass: ICU-vs-Foundation collation byte-parity is only
//   verifiable there (plan §7).

// swiftlint:disable file_length type_body_length

import ADContent
import ADJSONCore
import Foundation

/// One HIG topic's category membership (scope-group-data.js `higGroups` value).
public struct HigGroup: Sendable, Equatable {
    public let label: String
    public let parentPath: String
    public let order: Int
    public init(label: String, parentPath: String, order: Int) {
        self.label = label
        self.parentPath = parentPath
        self.order = order
    }
}

/// The extras bag threaded into `buildScopeGroups` (`opts.scopeExtras`).
public struct ScopeExtras: Sendable {
    /// topic path → its category membership; nil/empty ⇒ the HIG grouper
    /// falls through to role grouping (the JS `return null`).
    public var higGroups: [String: HigGroup]
    public init(higGroups: [String: HigGroup] = [:]) {
        self.higGroups = higGroups
    }
}

enum ScopeGroups {
    // MARK: - shared readers over the framework-page doc JSON

    /// Present-and-non-null member lookup. `doc[name]` returns a MISSING
    /// node for an absent key (whose coercions read as ""), so membership is
    /// resolved via forEachMember (last value wins, like JS object reads).
    static func member(_ doc: JSON, _ name: String) -> JSON? {
        var found: JSON?
        doc.forEachMember { key, value in
            if key == name { found = value }
        }
        guard let node = found, !node.isNull else { return nil }
        return node
    }

    static func stringMember(_ doc: JSON, _ name: String) -> String? {
        member(doc, name)?.string
    }

    /// `String(doc?.title ?? doc?.key ?? doc?.path ?? '')`.
    static func docTitle(_ doc: JSON) -> String {
        stringMember(doc, "title") ?? stringMember(doc, "key") ?? stringMember(doc, "path") ?? ""
    }

    /// `String(doc?.path ?? doc?.key ?? '')`.
    static func docPath(_ doc: JSON) -> String {
        stringMember(doc, "path") ?? stringMember(doc, "key") ?? ""
    }

    /// `path.slice(path.lastIndexOf('/') + 1)`.
    static func lastSegment(_ doc: JSON) -> String {
        let path = docPath(doc)
        guard let slash = path.lastIndex(of: "/") else { return path }
        return String(path[path.index(after: slash)...])
    }

    /// `a.localeCompare(b)` — ICU collation approximated by Foundation's
    /// en_US locale compare (flagged for real-corpus validation).
    static func localeCompare(_ a: String, _ b: String) -> Int {
        switch a.compare(b, options: [], range: nil, locale: Locale(identifier: "en_US")) {
            case .orderedAscending: return -1
            case .orderedDescending: return 1
            case .orderedSame: return 0
        }
    }

    static func byTitle(_ a: JSON, _ b: JSON) -> Int {
        localeCompare(docTitle(a), docTitle(b))
    }

    /// A JS-stable sort: strictly-less comparator over (element, index) pairs.
    static func stableSorted<T>(_ items: [T], compare: (T, T) -> Int) -> [T] {
        items.enumerated()
            .sorted { a, b in
                let c = compare(a.element, b.element)
                if c != 0 { return c < 0 }
                return a.offset < b.offset
            }
            .map(\.element)
    }

    static func sortedByTitle(_ docs: [JSON]) -> [JSON] {
        stableSorted(docs) { byTitle($0, $1) }
    }

    /// `numericParts` — split on `.`/`_`, parseInt each, keep finite.
    static func numericParts(_ s: String) -> [Int] {
        s.split(whereSeparator: { $0 == "." || $0 == "_" })
            .compactMap { part -> Int? in
                // parseInt: leading digits (an optional sign not needed here).
                var digits = ""
                for ch in part {
                    guard ch.isNumber, ch.isASCII else { break }
                    digits.append(ch)
                }
                return digits.isEmpty ? nil : Int(digits)
            }
    }

    static func compareNumericParts(_ a: String, _ b: String) -> Int {
        let pa = numericParts(a)
        let pb = numericParts(b)
        for i in 0 ..< max(pa.count, pb.count) {
            let d = (i < pa.count ? pa[i] : 0) - (i < pb.count ? pb[i] : 0)
            if d != 0 { return d }
        }
        return 0
    }

    static func parseSourceMetadata(_ doc: JSON) -> JSON? {
        let raw = member(doc, "source_metadata") ?? member(doc, "sourceMetadata")
        guard let raw else { return nil }
        if raw.isObject { return raw }
        guard let text = raw.string, !text.isEmpty,
            let parsed = try? ADJSON.parse(text, options: .init(maxDepth: 512)).root,
            parsed.isObject
        else { return nil }
        return parsed
    }

    static func slug(_ label: String) -> String {
        RenderHelpers.slugify(label)
    }

    // MARK: - wwdc

    /// `groupWwdcByYear` — newest year first, titles within, "Other" trailing.
    static func groupWwdcByYear(_ docs: [JSON]) -> [FrameworkPage.ScopeSection] {
        var years: [Int] = []
        var byYear: [Int: [JSON]] = [:]
        var rest: [JSON] = []
        for doc in docs {
            guard let year = wwdcPathYear(docPath(doc)) else {
                rest.append(doc)
                continue
            }
            if byYear[year] == nil { years.append(year) }
            byYear[year, default: []].append(doc)
        }
        var sections = years.sorted(by: >)
            .map { year in
                FrameworkPage.ScopeSection(
                    id: "year-\(year)", label: String(year), count: byYear[year]?.count ?? 0,
                    docs: sortedByTitle(byYear[year] ?? []))
            }
        if !rest.isEmpty {
            sections.append(
                FrameworkPage.ScopeSection(
                    id: "year-other", label: "Other", count: rest.count, docs: sortedByTitle(rest)))
        }
        return sections
    }

    /// `/^wwdc\/wwdc(\d{4})-/` → the year.
    static func wwdcPathYear(_ path: String) -> Int? {
        let prefix = "wwdc/wwdc"
        guard path.hasPrefix(prefix) else { return nil }
        let tail = path.dropFirst(prefix.count)
        guard tail.count >= 5 else { return nil }
        let digits = tail.prefix(4)
        guard digits.allSatisfy({ $0.isNumber && $0.isASCII }),
            tail[tail.index(tail.startIndex, offsetBy: 4)] == "-"
        else { return nil }
        return Int(digits)
    }

    // MARK: - swift-evolution

    /// Prefix → family label, in display order (`SE_STATUS_FAMILIES`).
    static let seStatusFamilies: [(String, String)] = [
        ("active review", "Active Review"),
        ("scheduled for review", "Scheduled for Review"),
        ("awaiting review", "Awaiting Review"),
        ("accepted", "Accepted"),
        ("previewing", "Previewing"),
        ("partially implemented", "Partially Implemented"),
        ("implemented", "Implemented"),
        ("returned for revision", "Returned for Revision"),
        ("deferred", "Deferred"),
        ("rejected", "Rejected"),
        ("withdrawn", "Withdrawn"),
        ("expired", "Expired")
    ]

    static func swiftEvolutionStatusLabel(_ status: String?) -> String {
        let normalized = (status ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized.isEmpty { return "Other" }
        for (prefix, label) in seStatusFamilies where normalized.hasPrefix(prefix) {
            return label
        }
        return "Other"
    }

    /// `/(\d+)/` over `meta.seNumber`, else -1.
    static func seNumberValue(_ metadata: JSON?) -> Int {
        guard let raw = metadata.flatMap({ member($0, "seNumber") }) else { return -1 }
        let text = raw.string ?? raw.jsString
        var digits = ""
        var started = false
        for ch in text {
            if ch.isNumber && ch.isASCII {
                digits.append(ch)
                started = true
            } else if started {
                break
            }
        }
        return digits.isEmpty ? -1 : (Int(digits) ?? -1)
    }

    /// `groupSwiftEvolutionByStatus` — family order; SE number desc within;
    /// each doc gains a `meta` member ("SE-0001 · Swift 5.9").
    static func groupSwiftEvolutionByStatus(_ docs: [JSON]) -> [FrameworkPage.ScopeSection] {
        var labels: [String] = []
        var byStatus: [String: [(doc: JSON, seNumber: Int)]] = [:]
        for doc in docs {
            let metadata = parseSourceMetadata(doc)
            let label = swiftEvolutionStatusLabel(metadata.flatMap { member($0, "status")?.string })
            let seNumber = metadata.flatMap { member($0, "seNumber")?.string }
            // `metadata?.swiftVersion ? \`Swift ${…}\` : null` — truthiness: a
            // present, non-empty value.
            let swiftVersionText = metadata.flatMap { member($0, "swiftVersion") }
                .map { $0.string ?? $0.jsString }
                .flatMap { $0.isEmpty ? nil : $0 }
            let metaParts = [seNumber, swiftVersionText.map { "Swift \($0)" }].compactMap(\.self)
                .filter { !$0.isEmpty }
            let metaLine = metaParts.joined(separator: " · ")
            let enriched = withInjectedMeta(doc, meta: metaLine.isEmpty ? nil : metaLine)
            if byStatus[label] == nil { labels.append(label) }
            byStatus[label, default: []].append((doc: enriched, seNumber: seNumberValue(metadata)))
        }
        var familyOrder: [String: Int] = [:]
        for (index, family) in seStatusFamilies.enumerated() { familyOrder[family.1] = index }
        let orderedLabels = stableSorted(labels) { a, b in
            (familyOrder[a] ?? seStatusFamilies.count) - (familyOrder[b] ?? seStatusFamilies.count)
        }
        return orderedLabels.map { label in
            let entries = stableSorted(byStatus[label] ?? []) { a, b in
                let d = b.seNumber - a.seNumber
                if d != 0 { return d }
                return byTitle(a.doc, b.doc)
            }
            return FrameworkPage.ScopeSection(
                id: "status-\(slug(label))", label: label, count: entries.count,
                docs: entries.map(\.doc))
        }
    }

    /// `{...doc, meta}` — rebuild the doc JSON with a `meta` member appended
    /// (null when absent, matching the JS `meta: null`).
    static func withInjectedMeta(_ doc: JSON, meta: String?) -> JSON {
        var pairs: [(String, JsonLd)] = []
        doc.forEachMember { name, value in
            if name != "meta" { pairs.append((name, BuildSite.jsonLdValue(value))) }
        }
        pairs.append(("meta", meta.map(JsonLd.string) ?? .null))
        let text = JsonLd.object(pairs).serialized()
        return (try? ADJSON.parse(text, options: .init(maxDepth: 512)).root) ?? doc
    }

    // MARK: - sample-code

    static func groupSampleCodeByFramework(_ docs: [JSON]) -> [FrameworkPage.ScopeSection] {
        var labels: [String] = []
        var byFramework: [String: [JSON]] = [:]
        for doc in docs {
            let metadata = parseSourceMetadata(doc)
            let first = metadata.flatMap { meta -> String? in
                guard let frameworks = member(meta, "frameworks"), frameworks.isArray else { return nil }
                return frameworks[index: 0].string
            }
            let trimmed = first?.trimmingCharacters(in: .whitespacesAndNewlines)
            let label = (trimmed?.isEmpty == false) ? trimmed! : "Other"
            if byFramework[label] == nil { labels.append(label) }
            byFramework[label, default: []].append(doc)
        }
        let ordered = stableSorted(labels) { a, b in
            if a == "Other" { return 1 }
            if b == "Other" { return -1 }
            return localeCompare(a, b)
        }
        return ordered.map { label in
            FrameworkPage.ScopeSection(
                id: "fw-\(slug(label))", label: label, count: byFramework[label]?.count ?? 0,
                docs: sortedByTitle(byFramework[label] ?? []))
        }
    }

    // MARK: - guidelines

    static func groupGuidelinesBySection(_ docs: [JSON]) -> [FrameworkPage.ScopeSection] {
        var sectionNumbers: [Int] = []
        var bySection: [Int: [JSON]] = [:]
        var rest: [JSON] = []
        for doc in docs {
            let seg = lastSegment(doc)
            guard let section = guidelineSectionNumber(seg) else {
                rest.append(doc)
                continue
            }
            if bySection[section] == nil { sectionNumbers.append(section) }
            bySection[section, default: []].append(doc)
        }
        var sections = sectionNumbers.sorted()
            .map { section -> FrameworkPage.ScopeSection in
                let sectionDocs = stableSorted(bySection[section] ?? []) {
                    compareNumericParts(lastSegment($0), lastSegment($1))
                }
                let header = sectionDocs.first { lastSegment($0) == String(section) }
                return FrameworkPage.ScopeSection(
                    id: "section-\(section)", label: header.map(docTitle) ?? "Section \(section)",
                    count: sectionDocs.count, docs: sectionDocs)
            }
        if !rest.isEmpty {
            sections.append(
                FrameworkPage.ScopeSection(
                    id: "section-other", label: "Other", count: rest.count, docs: sortedByTitle(rest)))
        }
        return sections
    }

    /// `/^(\d+)(?:\.\d+)*$/` → the top-level number.
    static func guidelineSectionNumber(_ segment: String) -> Int? {
        let parts = segment.split(separator: ".", omittingEmptySubsequences: false)
        guard let first = parts.first, !first.isEmpty,
            parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy { $0.isNumber && $0.isASCII } })
        else { return nil }
        return Int(first)
    }

    // MARK: - release-notes

    static func groupReleaseNotesByVersion(_ docs: [JSON]) -> [FrameworkPage.ScopeSection] {
        var majors: [Int] = []
        var byMajor: [Int: (product: String, entries: [(doc: JSON, version: String)])] = [:]
        var rest: [JSON] = []
        for doc in docs {
            let title = docTitle(doc)
            guard let (version, index) = firstVersionInTitle(title) else {
                rest.append(doc)
                continue
            }
            let major = numericParts(version).first ?? 0
            let product = String(title.prefix(index)).trimmingCharacters(in: .whitespacesAndNewlines)
            if byMajor[major] == nil {
                majors.append(major)
                byMajor[major] = (product: product, entries: [])
            }
            if byMajor[major]?.product.isEmpty == true && !product.isEmpty {
                byMajor[major]?.product = product
            }
            byMajor[major]?.entries.append((doc: doc, version: version))
        }
        var sections = majors.sorted(by: >)
            .compactMap { major -> FrameworkPage.ScopeSection? in
                guard let group = byMajor[major] else { return nil }
                let ordered = stableSorted(group.entries) { compareNumericParts($1.version, $0.version) }
                return FrameworkPage.ScopeSection(
                    id: "v-\(major)",
                    label: group.product.isEmpty ? "Version \(major)" : "\(group.product) \(major)",
                    count: group.entries.count, docs: ordered.map(\.doc))
            }
        if !rest.isEmpty {
            sections.append(
                FrameworkPage.ScopeSection(
                    id: "v-other", label: "Other", count: rest.count, docs: sortedByTitle(rest)))
        }
        return sections
    }

    /// `/(\d+(?:[._]\d+)*)/` — the first version-ish run + its CHARACTER index
    /// (JS `m.index` over UTF-16; titles here are ASCII-safe for the slice).
    static func firstVersionInTitle(_ title: String) -> (version: String, index: Int)? {
        let chars = Array(title)
        var i = 0
        while i < chars.count {
            if chars[i].isNumber && chars[i].isASCII {
                var j = i
                var version = ""
                while j < chars.count {
                    if chars[j].isNumber && chars[j].isASCII {
                        version.append(chars[j])
                        j += 1
                    } else if chars[j] == "." || chars[j] == "_", j + 1 < chars.count,
                        chars[j + 1].isNumber && chars[j + 1].isASCII
                    {
                        version.append(chars[j])
                        j += 1
                    } else {
                        break
                    }
                }
                return (version: version, index: i)
            }
            i += 1
        }
        return nil
    }

    // MARK: - swift-book

    static let swiftBookParts: [(String, String)] = [
        ("The-Swift-Programming-Language", "Welcome to Swift"),
        ("GuidedTour", "A Swift Tour"),
        ("LanguageGuide", "Language Guide"),
        ("ReferenceManual", "Language Reference"),
        ("RevisionHistory", "Revision History")
    ]

    static func groupSwiftBookByPart(_ docs: [JSON]) -> [FrameworkPage.ScopeSection] {
        let partLabels = Dictionary(uniqueKeysWithValues: swiftBookParts)
        var labels: [String] = []
        var byPart: [String: [JSON]] = [:]
        for doc in docs {
            let path = stringMember(doc, "path") ?? ""
            let segments = path.split(separator: "/", omittingEmptySubsequences: false)
            let part = segments.count > 1 ? String(segments[1]) : ""
            let label = partLabels[part] ?? (part.isEmpty ? "Other" : part)
            if byPart[label] == nil { labels.append(label) }
            byPart[label, default: []].append(doc)
        }
        var readingOrder: [String: Int] = [:]
        for (index, part) in swiftBookParts.enumerated() { readingOrder[part.1] = index }
        let ordered = stableSorted(labels) { a, b in
            let d = (readingOrder[a] ?? 99) - (readingOrder[b] ?? 99)
            if d != 0 { return d }
            return localeCompare(a, b)
        }
        return ordered.map { label in
            FrameworkPage.ScopeSection(
                id: "part-\(slug(label))", label: label, count: byPart[label]?.count ?? 0,
                docs: sortedByTitle(byPart[label] ?? []))
        }
    }

    // MARK: - packages

    static func groupPackagesByOwner(_ docs: [JSON]) -> [FrameworkPage.ScopeSection] {
        var owners: [String] = []
        var byOwner: [String: [JSON]] = [:]
        var rest: [JSON] = []
        for doc in docs {
            let path = stringMember(doc, "path") ?? ""
            let segments = path.split(separator: "/", omittingEmptySubsequences: false)
            let owner = segments.count > 1 ? String(segments[1]) : ""
            guard !owner.isEmpty else {
                rest.append(doc)
                continue
            }
            if byOwner[owner] == nil { owners.append(owner) }
            byOwner[owner, default: []].append(doc)
        }
        let ordered = stableSorted(owners) { a, b in
            let d = (byOwner[b]?.count ?? 0) - (byOwner[a]?.count ?? 0)
            if d != 0 { return d }
            return localeCompare(a, b)
        }
        var sections = ordered.map { owner in
            FrameworkPage.ScopeSection(
                id: "owner-\(slug(owner))", label: owner, count: byOwner[owner]?.count ?? 0,
                docs: sortedByTitle(byOwner[owner] ?? []))
        }
        if !rest.isEmpty {
            sections.append(
                FrameworkPage.ScopeSection(
                    id: "owner-other", label: "Other", count: rest.count, docs: sortedByTitle(rest)))
        }
        return sections
    }

    // MARK: - technotes

    /// `/TN(\d+)/i` — newest TN number first, one section.
    static func sortTechnotes(_ docs: [JSON]) -> [FrameworkPage.ScopeSection] {
        let items = stableSorted(docs) { a, b in
            let ta = technoteNumber(docTitle(a))
            let tb = technoteNumber(docTitle(b))
            switch (ta, tb) {
                case (let na?, let nb?): return nb - na
                case (.some, nil): return -1
                case (nil, .some): return 1
                case (nil, nil): return byTitle(a, b)
            }
        }
        return [
            FrameworkPage.ScopeSection(
                id: "technotes-all", label: "All technotes — newest first", count: items.count,
                docs: items)
        ]
    }

    static func technoteNumber(_ title: String) -> Int? {
        let lower = title.lowercased()
        guard let range = lower.range(of: "tn") else { return nil }
        var digits = ""
        var index = range.upperBound
        while index < lower.endIndex, lower[index].isNumber, lower[index].isASCII {
            digits.append(lower[index])
            index = lower.index(after: index)
        }
        return digits.isEmpty ? nil : Int(digits)
    }

    // MARK: - apple-archive

    static let archiveLabels: [String: String] = [
        "cocoa": "Cocoa", "carbon": "Carbon", "quicktime": "QuickTime",
        "webobjects": "WebObjects", "appleapplications": "Apple Applications",
        "graphicsimaging": "Graphics & Imaging", "networkinginternet": "Networking & Internet",
        "hardwaredrivers": "Hardware & Drivers", "devicedrivers": "Device Drivers",
        "developertools": "Developer Tools", "userexperience": "User Experience",
        "internetweb": "Internet & Web", "macosx": "Mac OS X"
    ]

    static func groupArchiveByCategory(_ docs: [JSON]) -> [FrameworkPage.ScopeSection] {
        var labels: [String] = []
        var byCategory: [String: [JSON]] = [:]
        for doc in docs {
            let raw = (stringMember(doc, "framework") ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let label: String
            if raw.isEmpty {
                label = "Other"
            } else if let mapped = archiveLabels[raw] {
                label = mapped
            } else {
                label = raw.prefix(1).uppercased() + raw.dropFirst()
            }
            if byCategory[label] == nil { labels.append(label) }
            byCategory[label, default: []].append(doc)
        }
        let ordered = stableSorted(labels) { a, b in
            if a == "Other" { return 1 }
            if b == "Other" { return -1 }
            let d = (byCategory[b]?.count ?? 0) - (byCategory[a]?.count ?? 0)
            if d != 0 { return d }
            return localeCompare(a, b)
        }
        return ordered.map { label in
            FrameworkPage.ScopeSection(
                id: "cat-\(slug(label))", label: label, count: byCategory[label]?.count ?? 0,
                docs: sortedByTitle(byCategory[label] ?? []))
        }
    }

    // MARK: - hig

    static func groupHigByCategory(_ docs: [JSON], higGroups: [String: HigGroup])
        -> [FrameworkPage.ScopeSection]?
    {
        guard !higGroups.isEmpty else { return nil }
        var parentPaths: [String: HigGroup] = [:]
        for group in higGroups.values { parentPaths[group.parentPath] = group }

        var labels: [String] = []
        var sections: [String: (order: Int, header: JSON?, docs: [JSON])] = [:]
        var rest: [JSON] = []
        for doc in docs {
            let path = stringMember(doc, "path") ?? ""
            let own = parentPaths[path]
            let membership = higGroups[path]
            guard let group = own ?? membership else {
                rest.append(doc)
                continue
            }
            if sections[group.label] == nil {
                labels.append(group.label)
                sections[group.label] = (order: group.order, header: nil, docs: [])
            }
            if own != nil {
                sections[group.label]?.header = doc
            } else {
                sections[group.label]?.docs.append(doc)
            }
        }
        let ordered = stableSorted(labels) { a, b in
            let d = (sections[a]?.order ?? 0) - (sections[b]?.order ?? 0)
            if d != 0 { return d }
            return localeCompare(a, b)
        }
        var out = ordered.compactMap { label -> FrameworkPage.ScopeSection? in
            guard let section = sections[label] else { return nil }
            var items = sortedByTitle(section.docs)
            if let header = section.header { items.insert(header, at: 0) }
            return FrameworkPage.ScopeSection(
                id: "hig-\(slug(label))", label: label, count: items.count, docs: items)
        }
        if !rest.isEmpty {
            out.append(
                FrameworkPage.ScopeSection(
                    id: "hig-other", label: "Other", count: rest.count, docs: sortedByTitle(rest)))
        }
        return out
    }

    // MARK: - dispatch

    /// Port of `buildScopeGroups(root, docs, extras)`.
    static func buildScopeGroups(
        framework: FrameworkRecord, documents: [JSON], extras: ScopeExtras
    ) -> FrameworkPage.ScopeResult? {
        let scope = framework.sourceType ?? framework.slug
        let slug = framework.slug
        guard !documents.isEmpty else { return nil }

        if scope == "wwdc" || slug == "wwdc" {
            let sections = groupWwdcByYear(documents)
            return FrameworkPage.ScopeResult(
                scope: "wwdc", sections: sections,
                nav: sections.map {
                    FrameworkPage.ScopeNavItem(href: "#\($0.id)", label: $0.label, count: $0.count ?? 0)
                })
        }
        if scope == "swift-evolution" || slug == "swift-evolution" {
            return FrameworkPage.ScopeResult(
                scope: "swift-evolution", sections: groupSwiftEvolutionByStatus(documents), nav: [])
        }
        if scope == "sample-code" || slug == "sample-code" {
            return FrameworkPage.ScopeResult(
                scope: "sample-code", sections: groupSampleCodeByFramework(documents), nav: [])
        }
        if scope == "guidelines" || slug == "app-store-review" {
            return FrameworkPage.ScopeResult(
                scope: "guidelines", sections: groupGuidelinesBySection(documents), nav: [])
        }
        if framework.kind == "release-notes" {
            return FrameworkPage.ScopeResult(
                scope: "release-notes", sections: groupReleaseNotesByVersion(documents), nav: [])
        }
        if scope == "swift-book" || slug == "swift-book" {
            return FrameworkPage.ScopeResult(
                scope: "swift-book", sections: groupSwiftBookByPart(documents), nav: [])
        }
        if scope == "packages" || slug == "packages" {
            let sections = groupPackagesByOwner(documents)
            return FrameworkPage.ScopeResult(
                scope: "packages", sections: sections,
                nav: sections.filter { ($0.count ?? 0) >= 20 }
                    .map {
                        FrameworkPage.ScopeNavItem(href: "#\($0.id)", label: $0.label, count: $0.count ?? 0)
                    })
        }
        if slug == "technotes" {
            return FrameworkPage.ScopeResult(
                scope: "technotes", sections: sortTechnotes(documents), nav: [])
        }
        if scope == "apple-archive" || slug == "apple-archive" {
            let sections = groupArchiveByCategory(documents)
            return FrameworkPage.ScopeResult(
                scope: "apple-archive", sections: sections,
                nav: sections.map {
                    FrameworkPage.ScopeNavItem(href: "#\($0.id)", label: $0.label, count: $0.count ?? 0)
                })
        }
        if scope == "hig" || slug == "design" {
            if let sections = groupHigByCategory(documents, higGroups: extras.higGroups) {
                return FrameworkPage.ScopeResult(scope: "hig", sections: sections, nav: [])
            }
        }
        return nil
    }
}
