import Testing

@testable import ADSearchCascade

@Suite struct FtsQueryTests {
    @Test func buildSingleTermIsPrefixGroup() {
        #expect(FtsQuery.build("foo") == "\"foo\"*")
    }

    @Test func buildEmptyIsEmptyPhrase() {
        #expect(FtsQuery.build("") == "\"\"")
        #expect(FtsQuery.build("   ") == "\"\"")
    }

    @Test func booleanPassthroughIsVerbatim() {
        #expect(FtsQuery.build("swiftui OR uikit") == "swiftui OR uikit")
        #expect(FtsQuery.build("foo AND bar NOT baz") == "foo AND bar NOT baz")
    }

    @Test func pathologicalBooleanCollapsesToPhrase() {
        let q = (0 ..< 200).map { "t\($0)" }.joined(separator: " OR ")
        let built = FtsQuery.build(q)
        #expect(built != q)
        #expect(built.hasPrefix("\""))
        #expect(built.hasSuffix("\""))
    }

    @Test func trigramAsciiIsVerbatim() {
        #expect(FtsQuery.trigram("hello world") == "hello world")
        #expect(FtsQuery.trigram("") == "\"\"")
    }
}

@Suite struct FilterHelperTests {
    @Test func compareVersionsOrders() {
        #expect(Filters.compareVersions("1.2.3", "1.2.3") == 0)
        #expect(Filters.compareVersions("1.2", "1.10") < 0)
        #expect(Filters.compareVersions("2.0", "1.9") > 0)
        #expect(Filters.compareVersions("17.0", "17") == 0)
    }

    @Test func compareVersionsSaturatesWithoutTrapping() {
        let huge = String(repeating: "9", count: 40)
        #expect(Filters.compareVersions(huge, "1") > 0)
        #expect(Filters.compareVersions("1", huge) < 0)
        #expect(Filters.compareVersions(huge, huge) == 0)
    }

    @Test func normalizeTrimsAndLowercases() {
        #expect(Filters.normalize("  HELLO  ") == "hello")
    }

    @Test func normalizeDeprecatedFilterFallsBackToInclude() {
        #expect(Filters.normalizeDeprecatedFilter("exclude") == "exclude")
        #expect(Filters.normalizeDeprecatedFilter("ONLY") == "only")
        #expect(Filters.normalizeDeprecatedFilter("bogus") == "include")
        #expect(Filters.normalizeDeprecatedFilter(nil) == "include")
    }

    @Test func normalizeSourceListDedupesInOrder() {
        #expect(Filters.normalizeSourceList("a, b ,a, ,c") == ["a", "b", "c"])
        #expect(Filters.normalizeSourceList(nil).isEmpty)
    }
}
