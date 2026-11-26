import AemiJSONCore
import AppleDocsContent
import AppleDocsCore
import Foundation
import Testing

/// Differential test against the Bun reference normalizer: every fixture's DocC render JSON must convert to
/// exactly the document fields, sections (plain `content_text`, structured `content_json`, slot `sort_order`)
/// and relationships that Bun's `normalize()` produced (`Scripts/generate-docc-parity-golden.mjs`).
@Suite("DocC normalization parity with Bun (golden files)")
struct DocCNormalizationParityTests {
    struct Fixture: CustomTestStringConvertible, Sendable {
        let name: String
        let key: String
        let sourceType: String
        var testDescription: String { name }
    }

    static let fixtures: [Fixture] = {
        guard let data = try? Data(contentsOf: fixtureURL("manifest.json")),
            let root = try? AemiJSON.parse(Array(data)).root
        else { return [] }
        return (root.array ?? [])
            .compactMap { entry in
                guard let name = entry["name"].string, let key = entry["key"].string else { return nil }
                return Fixture(name: name, key: key, sourceType: entry["sourceType"].string ?? "apple-docc")
            }
    }()

    static func fixtureURL(_ file: String) -> URL {
        (Bundle.module.resourceURL ?? Bundle.module.bundleURL).appendingPathComponent("Fixtures/DocCParity/\(file)")
    }

    @Test func `golden fixtures are present`() {
        #expect(Self.fixtures.count >= 9)
    }

    @Test(arguments: fixtures)
    func `matches Bun normalization`(_ fixture: Fixture) throws {
        let input = try Data(contentsOf: Self.fixtureURL("\(fixture.name).input.json"))
        let golden = try AemiJSON.parse(Array(try Data(contentsOf: Self.fixtureURL("\(fixture.name).bun.json")))).root
        let converted = try DocCJSONConverter.convert(
            json: Array(input),
            key: try DocumentKey(fixture.key),
            sourceType: SourceKind(rawValue: fixture.sourceType) ?? .appleDocC
        )
        compareDocument(converted.document, golden["document"])
        compareSections(converted.sections, golden["sections"])
        compareRelationships(converted.relationships, golden["relationships"])
        let header = BunMarkdownRenderer.Header(
            key: fixture.key,
            title: converted.document.title,
            framework: converted.document.framework,
            role: converted.document.role,
            roleHeading: converted.document.roleHeading,
            platformsJSON: converted.document.platformsJSON
        )
        let markdown = BunMarkdownRenderer.render(header, sections: converted.sections)
        #expect(markdown == golden["markdown"].string)
    }

    private func compareDocument(_ document: DocumentRecord, _ expected: JSON) {
        #expect(document.title == expected["title"].string)
        #expect(document.kind == expected["kind"].string)
        #expect(document.role == expected["role"].string)
        #expect(document.roleHeading == expected["roleHeading"].string)
        #expect(document.framework == expected["framework"].string)
        #expect(document.url == expected["url"].string)
        #expect(document.language == expected["language"].string)
        #expect(document.abstractText == expected["abstractText"].string)
        #expect(document.declarationText == expected["declarationText"].string)
        #expect(document.headings == expected["headings"].string)
        #expect(document.availability.ios == expected["minIos"].string)
        #expect(document.availability.macos == expected["minMacos"].string)
        #expect(document.availability.watchos == expected["minWatchos"].string)
        #expect(document.availability.tvos == expected["minTvos"].string)
        #expect(document.availability.visionos == expected["minVisionos"].string)
        let platforms = document.platformsJSON.flatMap { try? AemiJSON.parse(Array($0.utf8)).root }.map(JSONValue.init)
        let wantedPlatforms = expected["platformsJson"].string
            .flatMap { try? AemiJSON.parse(Array($0.utf8)).root }.map(JSONValue.init)
        #expect(platforms == wantedPlatforms)
        #expect(document.isDeprecated == (expected["isDeprecated"].bool ?? false))
        #expect(document.isBeta == (expected["isBeta"].bool ?? false))
        #expect(document.isReleaseNotes == (expected["isReleaseNotes"].bool ?? false))
        #expect(document.urlDepth == expected["urlDepth"].int)
    }

    private func compareSections(_ sections: [DocumentSectionRecord], _ expected: JSON) {
        let goldens = expected.array ?? []
        #expect(sections.map(\.sectionKind) == goldens.compactMap { $0["sectionKind"].string })
        #expect(sections.map(\.sortOrder) == goldens.compactMap { $0["sortOrder"].int })
        for (section, golden) in zip(sections, goldens) {
            #expect(section.heading == golden["heading"].string, "\(section.sectionKind) heading")
            #expect(section.contentText == (golden["contentText"].string ?? ""), "\(section.sectionKind) text")
            let actual = section.contentJSON.flatMap { try? AemiJSON.parse(Array($0.utf8)).root }.map(JSONValue.init)
            let wanted = golden["contentJson"].isNull ? nil : JSONValue(golden["contentJson"])
            #expect(actual == wanted, "\(section.sectionKind) content_json")
        }
    }

    private func compareRelationships(_ relationships: [DocumentRelationshipRecord], _ expected: JSON) {
        let actual = relationships.map {
            "\($0.toKey.rawValue)|\($0.relationType)|\($0.section ?? "-")|\($0.sortOrder)"
        }
        // Bun upserts on (from, to, type): the last occurrence of a repeated edge wins.
        var wanted: [String] = []
        var indexByEdge: [String: Int] = [:]
        for edge in expected.array ?? [] {
            guard let to = edge["toKey"].string, let type = edge["relationType"].string else { continue }
            let row = "\(to)|\(type)|\(edge["section"].string ?? "-")|\(edge["sortOrder"].int ?? -1)"
            if let index = indexByEdge["\(to)|\(type)"] {
                wanted[index] = row
            } else {
                indexByEdge["\(to)|\(type)"] = wanted.count
                wanted.append(row)
            }
        }
        #expect(actual == wanted)
    }
}
