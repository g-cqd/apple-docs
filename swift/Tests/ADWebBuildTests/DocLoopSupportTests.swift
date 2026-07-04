import ADContent
import Testing

@testable import ADWebBuild

// S5 render-loop support: fontsFamiliesJson (listAppleFonts stringify parity)
// and enrichTopicSections (enrichTopicItems) vs bun-pinned oracles.

// MARK: - fixtures (file scope for the type-check budget)

private let fontFamiliesFixture: [FontRow] = [
    FontRow(cells: [
        ("id", .text("sf-pro")), ("display_name", .text("SF Pro")), ("source_url", .null),
        ("source_size", .integer(1234)), ("status", .text("available")),
        ("updated_at", .text("2026-01-01T00:00:00.000Z"))
    ]),
    FontRow(cells: [
        ("id", .text("zz")), ("display_name", .text("ZZ")), ("source_url", .text("https://x/y.zip")),
        ("source_size", .null), ("status", .text("available")),
        ("updated_at", .text("2026-01-01T00:00:00.000Z"))
    ])
]

private let fontFilesFixture: [FontRow] = [
    FontRow(cells: [
        ("id", .text("f1")), ("family_id", .text("sf-pro")), ("file_name", .text("A.ttf")),
        ("italic", .integer(0)), ("is_variable", .integer(1)), ("format", .text("ttf")),
        ("axes_json", .text("[{\"tag\":\"wght\",\"min\":100.5,\"max\":900}]")), ("size", .integer(10))
    ]),
    FontRow(cells: [
        ("id", .text("f2")), ("family_id", .text("sf-pro")), ("file_name", .text("B.otf")),
        ("italic", .integer(1)), ("is_variable", .integer(0)), ("format", .null),
        ("axes_json", .null), ("size", .null)
    ]),
    FontRow(cells: [
        ("id", .text("f3")), ("family_id", .text("orphan")), ("file_name", .text("C.ttc")),
        ("italic", .integer(0)), ("is_variable", .integer(0)), ("format", .text("ttc")),
        ("axes_json", .text("not-json")), ("size", .integer(5))
    ])
]

/// `JSON.stringify(listFonts())` for the fixtures, pinned from bun (note the
/// bool coercions, the RAW axes_json string kept, the parsed `axes` appended,
/// and files [] for a family with no rows; the orphan file attaches nowhere).
private let fontsExpected =
    "[{\"id\":\"sf-pro\",\"display_name\":\"SF Pro\",\"source_url\":null,\"source_size\":1234,\"status\":\"available\",\"updated_at\":\"2026-01-01T00:00:00.000Z\",\"files\":[{\"id\":\"f1\",\"family_id\":\"sf-pro\",\"file_name\":\"A.ttf\",\"italic\":false,\"is_variable\":true,\"format\":\"ttf\",\"axes_json\":\"[{\\\"tag\\\":\\\"wght\\\",\\\"min\\\":100.5,\\\"max\\\":900}]\",\"size\":10,\"axes\":[{\"tag\":\"wght\",\"min\":100.5,\"max\":900}]},{\"id\":\"f2\",\"family_id\":\"sf-pro\",\"file_name\":\"B.otf\",\"italic\":true,\"is_variable\":false,\"format\":null,\"axes_json\":null,\"size\":null,\"axes\":[]}]},{\"id\":\"zz\",\"display_name\":\"ZZ\",\"source_url\":\"https://x/y.zip\",\"source_size\":null,\"status\":\"available\",\"updated_at\":\"2026-01-01T00:00:00.000Z\",\"files\":[]}]"

private let topicsInput =
    "[{\"title\":\"Essentials\",\"items\":[{\"key\":\"a/b\",\"title\":\"B\",\"extra\":1.50},{\"key\":\"a/c\"},{\"title\":\"nokey\"}]},{\"items\":[{\"key\":\"a/miss\"}]},\"passthrough\"]"

/// The enriched re-stringify from bun: `extra` NORMALIZED to 1.5, the
/// `_resolvedRoleHeading` members appended last on matched items, misses and
/// the non-object group untouched.
private let topicsExpected =
    "[{\"title\":\"Essentials\",\"items\":[{\"key\":\"a/b\",\"title\":\"B\",\"extra\":1.5,\"_resolvedRoleHeading\":\"Protocol\"},{\"key\":\"a/c\",\"_resolvedRoleHeading\":\"Structure\"},{\"title\":\"nokey\"}]},{\"items\":[{\"key\":\"a/miss\"}]},\"passthrough\"]"

private let topicsRoleMap = ["a/b": "Protocol", "a/c": "Structure"]

// MARK: - fonts JSON

@Test func fontsFamiliesJsonByteExact() {
    let json = BuildSite.fontsFamiliesJson(families: fontFamiliesFixture, files: fontFilesFixture)
    #expect(json == fontsExpected)
}

@Test func fontsFamiliesJsonNilAndEmpty() {
    #expect(BuildSite.fontsFamiliesJson(families: nil, files: nil) == nil)
    #expect(BuildSite.fontsFamiliesJson(families: [], files: []) == "[]")
}

// MARK: - computeSectionsDigest (checkpoint.js)

@Test func sectionsDigestMatchesBunOracle() {
    // Pinned from bun computeSectionsDigest: kinds + UTF-16 lengths + json
    // length-or-flag + ECMA sort_order, '|'-joined, sha256[:16]. A NULL kind
    // joins as '' and a NULL sort_order as '0' (the reader coalesces to 0).
    let sections = [
        DocSection(
            sectionKind: "content", heading: nil, contentText: "Views are the building blocks.",
            contentJson: nil, sortOrder: 0),
        DocSection(
            sectionKind: "topics", heading: nil, contentText: "",
            contentJson: "[{\"items\":[]}]", sortOrder: 1.5),
        DocSection(sectionKind: nil, heading: nil, contentText: nil, contentJson: nil, sortOrder: 0)
    ]
    #expect(BuildSite.computeSectionsDigest(sections) == "6252b23681d5120e")
    #expect(BuildSite.computeSectionsDigest([]) == "empty")
}

// MARK: - enrichTopicSections

@Test func enrichTopicSectionsByteExact() {
    let sections = [
        DocSection(sectionKind: "topics", heading: nil, contentText: "", contentJson: topicsInput, sortOrder: 0),
        DocSection(sectionKind: "content", heading: "Overview", contentText: "text", contentJson: nil, sortOrder: 1)
    ]
    let enriched = BuildSite.enrichTopicSections(sections) { keys in
        var out: [String: String] = [:]
        for key in keys {
            if let heading = topicsRoleMap[key] { out[key] = heading }
        }
        return out
    }
    #expect(enriched[0].contentJson == topicsExpected)
    // Non-topics sections pass through untouched.
    #expect(enriched[1].contentJson == nil)
    #expect(enriched[1].contentText == "text")
}

@Test func enrichTopicSectionsSkipsUnparseableAndKeyless() {
    let bad = DocSection(sectionKind: "topics", heading: nil, contentText: "", contentJson: "not json", sortOrder: 0)
    let keyless = DocSection(
        sectionKind: "topics", heading: nil, contentText: "",
        contentJson: "[{\"items\":[{\"title\":\"x\"}]}]", sortOrder: 0)
    let enriched = BuildSite.enrichTopicSections([bad, keyless]) { _ in ["a": "b"] }
    // Both `continue` paths: the original text is untouched (no normalization).
    #expect(enriched[0].contentJson == "not json")
    #expect(enriched[1].contentJson == "[{\"items\":[{\"title\":\"x\"}]}]")
}
