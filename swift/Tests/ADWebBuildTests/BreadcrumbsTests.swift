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

@Test func breadcrumbJsonLdMulti() {
    let actual = Breadcrumbs.buildBreadcrumbListJsonLd(
        "swiftui/view/body", baseUrl: "https://x.test/", title: "body", framework: "SwiftUI")?
        .serialized()
    let expected =
        "{\"@type\":\"BreadcrumbList\",\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"name\":\"SwiftUI\",\"item\":\"https://x.test/docs/swiftui/\"},{\"@type\":\"ListItem\",\"position\":2,\"name\":\"view\",\"item\":\"https://x.test/docs/swiftui/view/\"},{\"@type\":\"ListItem\",\"position\":3,\"name\":\"body\"}]}"
    #expect(actual == expected)
}

@Test func breadcrumbJsonLdSingleAndNil() {
    let one = Breadcrumbs.buildBreadcrumbListJsonLd("swiftui", baseUrl: "https://x.test", title: "SwiftUI")?
        .serialized()
    #expect(
        one
            == "{\"@type\":\"BreadcrumbList\",\"itemListElement\":[{\"@type\":\"ListItem\",\"position\":1,\"name\":\"SwiftUI\"}]}"
    )
    #expect(Breadcrumbs.buildBreadcrumbListJsonLd("", baseUrl: "x") == nil)
}
