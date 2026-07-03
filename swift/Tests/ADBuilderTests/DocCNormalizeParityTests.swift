// Parity gate for the native DocC-JSON normalizer (swift/Sources/ADBuilder/Sources/DocC): the
// JS `normalize()` output is pinned in Fixtures/DocCNormalize/cases.json (produced by
// scripts/gen-docc-normalize-fixtures.mjs). For each case, `DocC.normalizeDocC` must reproduce
// the pinned `NormalizedPage` field-for-field — INCLUDING every `contentJson` string, which must
// equal the JS `JSON.stringify` output byte-for-byte.

import Foundation
import Testing

@testable import ADBuilder

@Suite("DocC normalize — JS oracle parity")
struct DocCNormalizeParityTests {
    struct Case: Decodable, Sendable {
        let name: String
        let key: String
        let sourceType: String
        let input: String
        let expected: NormalizedPage
        let expectedReferences: [String]
    }

    static let cases: [Case] = {
        guard let base = Bundle.module.url(forResource: "Fixtures", withExtension: nil) else {
            fatalError("ADBuilderTests: Fixtures/ resource directory not bundled")
        }
        let url = base.appendingPathComponent("DocCNormalize/cases.json")
        guard let data = try? Data(contentsOf: url) else {
            fatalError("ADBuilderTests: DocCNormalize/cases.json missing")
        }
        do {
            return try JSONDecoder().decode([Case].self, from: data)
        } catch {
            fatalError("ADBuilderTests: cases.json decode failed: \(error)")
        }
    }()

    @Test("normalizeDocC reproduces the JS oracle for every pinned case")
    func parity() {
        #expect(Self.cases.count >= 13)
        for testCase in Self.cases {
            let bytes = Array(testCase.input.utf8)
            guard
                let page = DocC.normalizeDocC(
                    jsonBytes: bytes, key: testCase.key, sourceType: testCase.sourceType)
            else {
                Issue.record("case \(testCase.name): normalizeDocC returned nil")
                continue
            }
            if let diff = Self.difference(page, testCase.expected) {
                Issue.record("case \(testCase.name): \(diff)")
            }
            let references = DocC.extractReferences(jsonBytes: bytes)
            if references != testCase.expectedReferences {
                Issue.record(
                    "case \(testCase.name): extractReferences\n  actual=\(references)\n  expected=\(testCase.expectedReferences)")
            }
        }
    }

    // MARK: - precise mismatch reporting

    static func difference(_ actual: NormalizedPage, _ expected: NormalizedPage) -> String? {
        if actual.document != expected.document {
            return "document: \(documentDiff(actual.document, expected.document))"
        }
        if actual.sections.count != expected.sections.count {
            return
                "section count \(actual.sections.count) != \(expected.sections.count) "
                + "(actual kinds \(actual.sections.map(\.sectionKind)), expected \(expected.sections.map(\.sectionKind)))"
        }
        for index in actual.sections.indices where actual.sections[index] != expected.sections[index] {
            return "section[\(index)] \(sectionDiff(actual.sections[index], expected.sections[index]))"
        }
        if actual.relationships != expected.relationships {
            return "relationships:\n  actual=\(actual.relationships)\n  expected=\(expected.relationships)"
        }
        return nil
    }

    private static func documentDiff(_ a: NormalizedDocument, _ e: NormalizedDocument) -> String {
        var diffs: [String] = []
        func check(_ label: String, _ lhs: String?, _ rhs: String?) {
            if lhs != rhs { diffs.append("\(label): \(String(describing: lhs)) != \(String(describing: rhs))") }
        }
        check("title", a.title, e.title)
        check("kind", a.kind, e.kind)
        check("role", a.role, e.role)
        check("roleHeading", a.roleHeading, e.roleHeading)
        check("framework", a.framework, e.framework)
        check("url", a.url, e.url)
        check("language", a.language, e.language)
        check("abstractText", a.abstractText, e.abstractText)
        check("declarationText", a.declarationText, e.declarationText)
        check("platformsJson", a.platformsJson, e.platformsJson)
        check("minIos", a.minIos, e.minIos)
        check("minMacos", a.minMacos, e.minMacos)
        check("minWatchos", a.minWatchos, e.minWatchos)
        check("minTvos", a.minTvos, e.minTvos)
        check("minVisionos", a.minVisionos, e.minVisionos)
        check("headings", a.headings, e.headings)
        check("sourceMetadata", a.sourceMetadata, e.sourceMetadata)
        if a.isDeprecated != e.isDeprecated { diffs.append("isDeprecated: \(String(describing: a.isDeprecated)) != \(String(describing: e.isDeprecated))") }
        if a.isBeta != e.isBeta { diffs.append("isBeta: \(String(describing: a.isBeta)) != \(String(describing: e.isBeta))") }
        if a.isReleaseNotes != e.isReleaseNotes { diffs.append("isReleaseNotes: \(String(describing: a.isReleaseNotes)) != \(String(describing: e.isReleaseNotes))") }
        if a.urlDepth != e.urlDepth { diffs.append("urlDepth: \(String(describing: a.urlDepth)) != \(String(describing: e.urlDepth))") }
        return diffs.joined(separator: "; ")
    }

    private static func sectionDiff(_ a: NormalizedSection, _ e: NormalizedSection) -> String {
        var diffs: [String] = []
        if a.sectionKind != e.sectionKind { diffs.append("kind \(a.sectionKind) != \(e.sectionKind)") }
        if a.heading != e.heading { diffs.append("heading \(String(describing: a.heading)) != \(String(describing: e.heading))") }
        if a.contentText != e.contentText { diffs.append("contentText \(String(describing: a.contentText)) != \(String(describing: e.contentText))") }
        if a.contentJson != e.contentJson { diffs.append("contentJson:\n    actual=  \(String(describing: a.contentJson))\n    expected=\(String(describing: e.contentJson))") }
        if a.sortOrder != e.sortOrder { diffs.append("sortOrder \(a.sortOrder) != \(e.sortOrder)") }
        return diffs.joined(separator: "; ")
    }
}
