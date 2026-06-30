import Testing

@testable import ADWebBuild

@Test func breadcrumbSingleSegment() {
    #expect(
        Breadcrumbs.buildBreadcrumbs("swiftui", title: "SwiftUI")
            == "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\"><span>SwiftUI</span></nav>")
}

@Test func breadcrumbMultiSegmentAllKnown() {
    let actual = Breadcrumbs.buildBreadcrumbs(
        "swiftui/view/body", title: "body", framework: "SwiftUI",
        knownKeys: ["swiftui", "swiftui/view", "swiftui/view/body"])
    let expected =
        "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\"><a href=\"/docs/swiftui/\">SwiftUI</a><span class=\"breadcrumb-sep\" aria-hidden=\"true\"> / </span><a href=\"/docs/swiftui/view/\">view</a><span class=\"breadcrumb-sep\" aria-hidden=\"true\"> / </span><span aria-current=\"page\">body</span></nav>"
    #expect(actual == expected)
}

@Test func breadcrumbUnknownIntermediateIsPlainText() {
    let actual = Breadcrumbs.buildBreadcrumbs(
        "swift-book/LanguageGuide/TheBasics", title: "The Basics",
        framework: "The Swift Programming Language",
        knownKeys: ["swift-book", "swift-book/LanguageGuide/TheBasics"])
    let expected =
        "<nav class=\"breadcrumbs\" aria-label=\"Breadcrumb\"><a href=\"/docs/swift-book/\">The Swift Programming Language</a><span class=\"breadcrumb-sep\" aria-hidden=\"true\"> / </span><span>LanguageGuide</span><span class=\"breadcrumb-sep\" aria-hidden=\"true\"> / </span><span aria-current=\"page\">The Basics</span></nav>"
    #expect(actual == expected)
}

@Test func breadcrumbEmptyKey() {
    #expect(Breadcrumbs.buildBreadcrumbs("") == "")
}
