import Testing

@testable import ADWebBuild

@Test func docMetaFullBadgesAndPlatforms() {
    let doc = DocRecord(
        frameworkDisplay: "SwiftUI", roleHeading: "Structure", isDeprecated: true,
        platformsJson: #"{"ios":"16.0","macos":"13.0"}"#)
    let expected =
        "<div class=\"doc-meta\"><span class=\"badge badge-framework\">SwiftUI</span><span class=\"badge badge-role\">Structure</span><span class=\"badge badge-deprecated\">Deprecated</span></div>\n  <div class=\"doc-availability\"><span class=\"badge badge-platform\">iOS 16.0+</span><span class=\"badge badge-platform\">macOS 13.0+</span></div>"
    #expect(DocMeta.buildDocMeta(doc) == expected)
}

@Test func docMetaMinimal() {
    #expect(
        DocMeta.buildDocMeta(DocRecord(framework: "swiftui"))
            == "<div class=\"doc-meta\"><span class=\"badge badge-framework\">swiftui</span></div>")
}

@Test func originalResourceBlock() {
    let expected =
        "<div class=\"sidebar-block sidebar-source\">\n  <a href=\"https://developer.apple.com/documentation/swiftui\" target=\"_blank\" rel=\"noopener noreferrer\" class=\"sidebar-source-link\">Open on developer.apple.com</a>\n</div>"
    #expect(DocMeta.buildOriginalResourceBlock("https://developer.apple.com/documentation/swiftui") == expected)
    #expect(DocMeta.buildOriginalResourceBlock(nil) == "")
}
