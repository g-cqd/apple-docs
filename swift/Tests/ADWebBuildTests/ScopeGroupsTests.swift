import ADJSONCore
import Testing

@testable import ADWebBuild

// ScopeGroups vs the bun oracle — buildScopeGroups run over identical
// synthetic doc sets for all 10 scopes (ids/labels/counts/doc order + the SE
// meta injection + navs pinned). Titles are collation-safe ASCII so the
// flagged localeCompare approximation can't bite here (real-corpus pass owns
// that risk).

private func docs(_ json: String) -> [JSON] {
    (try? ADJSON.parse(json, options: .init(maxDepth: 512)).root)?.arrayValue ?? []
}

private func shape(_ result: FrameworkPage.ScopeResult?) -> [String] {
    guard let result else { return ["nil"] }
    var out = ["scope=\(result.scope)"]
    for nav in result.nav { out.append("nav:\(nav.href)|\(nav.label)|\(nav.count)") }
    for section in result.sections {
        let docList = section.docs.map { doc -> String in
            let path = doc["path"].string ?? doc["key"].string ?? "?"
            let metaNode = doc["meta"]
            let metaSuffix: String
            if metaNode.isNull {
                // Distinguish an INJECTED null meta from an absent member.
                var hasMeta = false
                doc.forEachMember { name, _ in
                    if name == "meta" { hasMeta = true }
                }
                metaSuffix = hasMeta ? "|meta=null" : ""
            } else if let meta = metaNode.string {
                metaSuffix = "|meta=\(meta)"
            } else {
                metaSuffix = ""
            }
            return path + metaSuffix
        }
        out.append("\(section.id)|\(section.label)|\(section.count ?? -1)|\(docList.joined(separator: ","))")
    }
    return out
}

private func group(_ record: FrameworkRecord, _ json: String, extras: ScopeExtras = ScopeExtras())
    -> [String]
{
    shape(ScopeGroups.buildScopeGroups(framework: record, documents: docs(json), extras: extras))
}

@Test func scopeWwdcMatchesOracle() {
    let out = group(
        FrameworkRecord(slug: "wwdc", sourceType: "wwdc"),
        #"[{"path":"wwdc/wwdc2024-10001","title":"Zeta session"},{"path":"wwdc/wwdc2024-10002","title":"Alpha session"},{"path":"wwdc/wwdc2023-201","title":"Old session"},{"path":"wwdc/keynote","title":"Keynote hub"}]"#
    )
    #expect(
        out == [
            "scope=wwdc",
            "nav:#year-2024|2024|2", "nav:#year-2023|2023|1", "nav:#year-other|Other|1",
            "year-2024|2024|2|wwdc/wwdc2024-10002,wwdc/wwdc2024-10001",
            "year-2023|2023|1|wwdc/wwdc2023-201",
            "year-other|Other|1|wwdc/keynote"
        ])
}

@Test func scopeSwiftEvolutionMatchesOracle() {
    let out = group(
        FrameworkRecord(slug: "swift-evolution", sourceType: "swift-evolution"),
        #"[{"path":"swift-evolution/0100","title":"Proposal hundred","source_metadata":"{\"status\":\"Implemented (Swift 5.9)\",\"seNumber\":\"SE-0100\",\"swiftVersion\":\"5.9\"}"},{"path":"swift-evolution/0200","title":"Proposal two hundred","source_metadata":"{\"status\":\"Implemented (Swift 6.0)\",\"seNumber\":\"SE-0200\",\"swiftVersion\":\"6.0\"}"},{"path":"swift-evolution/0300","title":"Accepted thing","source_metadata":"{\"status\":\"Accepted with modifications\",\"seNumber\":\"SE-0300\"}"},{"path":"swift-evolution/vision","title":"A vision doc","source_metadata":"{\"status\":\"Something Weird\"}"}]"#
    )
    #expect(
        out == [
            "scope=swift-evolution",
            "status-accepted|Accepted|1|swift-evolution/0300|meta=SE-0300",
            "status-implemented|Implemented|2|swift-evolution/0200|meta=SE-0200 · Swift 6.0,swift-evolution/0100|meta=SE-0100 · Swift 5.9",
            "status-other|Other|1|swift-evolution/vision|meta=null"
        ])
}

@Test func scopeGuidelinesMatchesOracle() {
    let out = group(
        FrameworkRecord(slug: "app-store-review", sourceType: "guidelines"),
        #"[{"path":"app-store-review/1","title":"1. Safety"},{"path":"app-store-review/1.10","title":"1.10 Tenth rule"},{"path":"app-store-review/1.2","title":"1.2 Second rule"},{"path":"app-store-review/2","title":"2. Performance"},{"path":"app-store-review/intro","title":"Introduction"}]"#
    )
    #expect(
        out == [
            "scope=guidelines",
            "section-1|1. Safety|3|app-store-review/1,app-store-review/1.2,app-store-review/1.10",
            "section-2|2. Performance|1|app-store-review/2",
            "section-other|Other|1|app-store-review/intro"
        ])
}

@Test func scopeReleaseNotesMatchesOracle() {
    let out = group(
        FrameworkRecord(slug: "ios-release-notes", kind: "release-notes"),
        #"[{"path":"rn/ios-18-2","title":"iOS 18.2 Release Notes"},{"path":"rn/ios-18-10","title":"iOS 18.10 Release Notes"},{"path":"rn/ios-17-1","title":"iOS 17.1 Release Notes"},{"path":"rn/foundation","title":"Foundation Release Notes"}]"#
    )
    #expect(
        out == [
            "scope=release-notes",
            "v-18|iOS 18|2|rn/ios-18-10,rn/ios-18-2",
            "v-17|iOS 17|1|rn/ios-17-1",
            "v-other|Other|1|rn/foundation"
        ])
}

@Test func scopeSwiftBookMatchesOracle() {
    let out = group(
        FrameworkRecord(slug: "swift-book", sourceType: "swift-book"),
        #"[{"path":"swift-book/ReferenceManual/Types","title":"Types"},{"path":"swift-book/LanguageGuide/TheBasics","title":"The Basics"},{"path":"swift-book/LanguageGuide/Closures","title":"Closures"},{"path":"swift-book/The-Swift-Programming-Language","title":"The Swift Programming Language"},{"path":"swift-book/Weird/Extra","title":"Extra"}]"#
    )
    #expect(
        out == [
            "scope=swift-book",
            "part-welcome-to-swift|Welcome to Swift|1|swift-book/The-Swift-Programming-Language",
            "part-language-guide|Language Guide|2|swift-book/LanguageGuide/Closures,swift-book/LanguageGuide/TheBasics",
            "part-language-reference|Language Reference|1|swift-book/ReferenceManual/Types",
            "part-weird|Weird|1|swift-book/Weird/Extra"
        ])
}

@Test func scopePackagesAndTechnotesMatchOracle() {
    let packages = group(
        FrameworkRecord(slug: "packages", sourceType: "packages"),
        #"[{"path":"packages/apple/swift-nio","title":"swift-nio"},{"path":"packages/apple/swift-log","title":"swift-log"},{"path":"packages/vapor/vapor","title":"vapor"}]"#
    )
    #expect(
        packages == [
            "scope=packages",
            "owner-apple|apple|2|packages/apple/swift-log,packages/apple/swift-nio",
            "owner-vapor|vapor|1|packages/vapor/vapor"
        ])

    let technotes = group(
        FrameworkRecord(slug: "technotes"),
        #"[{"path":"technotes/tn3100","title":"TN3100: New thing"},{"path":"technotes/tn3105","title":"TN3105: Newest thing"},{"path":"technotes/about","title":"About technotes"}]"#
    )
    #expect(
        technotes == [
            "scope=technotes",
            "technotes-all|All technotes — newest first|3|technotes/tn3105,technotes/tn3100,technotes/about"
        ])
}

@Test func scopeArchiveAndSampleMatchOracle() {
    let archive = group(
        FrameworkRecord(slug: "apple-archive", sourceType: "apple-archive"),
        #"[{"path":"apple-archive/documentation/Cocoa/A","title":"Alpha guide","framework":"cocoa"},{"path":"apple-archive/documentation/Cocoa/B","title":"Beta guide","framework":"cocoa"},{"path":"apple-archive/documentation/QuickTime/C","title":"QT guide","framework":"quicktime"},{"path":"apple-archive/documentation/Zunknown/D","title":"Mystery","framework":"zunknowncat"},{"path":"apple-archive/other","title":"No framework"}]"#
    )
    #expect(
        archive == [
            "scope=apple-archive",
            "nav:#cat-cocoa|Cocoa|2", "nav:#cat-quicktime|QuickTime|1",
            "nav:#cat-zunknowncat|Zunknowncat|1", "nav:#cat-other|Other|1",
            "cat-cocoa|Cocoa|2|apple-archive/documentation/Cocoa/A,apple-archive/documentation/Cocoa/B",
            "cat-quicktime|QuickTime|1|apple-archive/documentation/QuickTime/C",
            "cat-zunknowncat|Zunknowncat|1|apple-archive/documentation/Zunknown/D",
            "cat-other|Other|1|apple-archive/other"
        ])

    let sample = group(
        FrameworkRecord(slug: "sample-code", sourceType: "sample-code"),
        #"[{"path":"sample-code/a","title":"App one","source_metadata":"{\"frameworks\":[\"SwiftUI\",\"UIKit\"]}"},{"path":"sample-code/b","title":"App two","source_metadata":"{\"frameworks\":[\"ARKit\"]}"},{"path":"sample-code/c","title":"App three","source_metadata":"{}"}]"#
    )
    #expect(
        sample == [
            "scope=sample-code",
            "fw-arkit|ARKit|1|sample-code/b",
            "fw-swiftui|SwiftUI|1|sample-code/a",
            "fw-other|Other|1|sample-code/c"
        ])
}

@Test func scopeHigAndFallbackMatchOracle() {
    let extras = ScopeExtras(higGroups: [
        "design/color": HigGroup(label: "Foundations", parentPath: "design/foundations", order: 0),
        "design/layout": HigGroup(label: "Foundations", parentPath: "design/foundations", order: 0),
        "design/buttons": HigGroup(label: "Components", parentPath: "design/components", order: 1)
    ])
    let hig = group(
        FrameworkRecord(slug: "design", sourceType: "hig"),
        #"[{"path":"design/foundations","title":"Foundations"},{"path":"design/layout","title":"Layout"},{"path":"design/color","title":"Color"},{"path":"design/buttons","title":"Buttons"},{"path":"design/stray","title":"Stray page"}]"#,
        extras: extras)
    #expect(
        hig == [
            "scope=hig",
            "hig-foundations|Foundations|3|design/foundations,design/color,design/layout",
            "hig-components|Components|1|design/buttons",
            "hig-other|Other|1|design/stray"
        ])

    // No higGroups ⇒ hig falls through to role grouping (nil).
    let noExtras = group(
        FrameworkRecord(slug: "design", sourceType: "hig"),
        #"[{"path":"design/color","title":"Color"}]"#)
    #expect(noExtras == ["nil"])

    // Ordinary frameworks keep role grouping.
    let fallback = group(
        FrameworkRecord(slug: "swiftui", kind: "framework"),
        #"[{"path":"swiftui/view","title":"View"}]"#)
    #expect(fallback == ["nil"])
}
