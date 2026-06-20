// Unit gate for the document chunker — the bit-exact port of src/search/chunker.js.
// Covers the anchor composition + UTF-16 cap, the section skip rules, the abstract
// de-dup, the sliding window (fit + overlap step), maxChunks, and JS trim/slice.

import Testing

@testable import ADEmbed

struct ChunkerTests {
    @Test func anchorJoinsTruthyFieldsWithDotSpace() {
        #expect(Chunker.anchorText(title: "View", abstractText: "An abstract.", headings: "Overview") == "View. An abstract.. Overview")
        // filter(Boolean): nil + empty fields drop out (no leading/double separators).
        #expect(Chunker.anchorText(title: "View", abstractText: nil, headings: "") == "View")
        #expect(Chunker.anchorText(title: nil, abstractText: "", headings: nil) == "")
    }

    @Test func anchorCapsAt1200UTF16Units() {
        let long = String(repeating: "a", count: 1300)
        let anchor = Chunker.anchorText(title: long, abstractText: nil, headings: nil)
        #expect(anchor.utf16.count == 1200)
    }

    @Test func slidingWindowFitsInOne() {
        #expect(Chunker.slidingWindow("abc", size: 4, overlap: 1) == ["abc"])
        #expect(Chunker.slidingWindow("abcd", size: 4, overlap: 1) == ["abcd"])
    }

    @Test func slidingWindowOverlapSteps() {
        // size 4, overlap 1 → step 3; "abcdefghij" → abcd / defg / ghij.
        #expect(Chunker.slidingWindow("abcdefghij", size: 4, overlap: 1) == ["abcd", "defg", "ghij"])
    }

    @Test func jsTrimStripsWhitespaceAndNewlines() {
        #expect(Chunker.jsTrim(" \n hi \t ") == "hi")
        #expect(Chunker.jsTrim("\u{00A0}x\u{2028}") == "x")  // NBSP + line separator are JS whitespace
        #expect(Chunker.jsTrim("no-trim") == "no-trim")
    }

    @Test func asciiLowercaseForSectionKinds() {
        #expect(Chunker.asciiLowercased("RESTResponse") == "restresponse")
        #expect(Chunker.asciiLowercased("Discussion") == "discussion")
    }

    @Test func anchorIsAlwaysChunkZero() {
        let chunks = Chunker.chunkDocument(title: "View", abstractText: nil, headings: nil, sections: [])
        #expect(chunks.count == 1)
        #expect(chunks[0] == "View")
    }

    @Test func bodySectionsBecomeHeadingPrefixedChunks() {
        let chunks = Chunker.chunkDocument(
            title: "View", abstractText: nil, headings: nil,
            sections: [Chunker.Section(kind: "discussion", heading: "Discussion", contentText: "Body text.")])
        #expect(chunks == ["View", "Discussion. Body text."])
    }

    @Test func skipsNoiseKindsRestAndDedupedAbstract() {
        let sections = [
            Chunker.Section(kind: "declaration", heading: nil, contentText: "var x"),
            Chunker.Section(kind: "Parameters", heading: nil, contentText: "p"),
            Chunker.Section(kind: "restResponse", heading: nil, contentText: "{}"),
            Chunker.Section(kind: "abstract", heading: nil, contentText: "dup abstract"),
            Chunker.Section(kind: "discussion", heading: nil, contentText: "kept"),
        ]
        let chunks = Chunker.chunkDocument(title: "T", abstractText: "A", headings: nil, sections: sections)
        // anchor + only the discussion body; declaration/parameters/rest*/abstract all skipped.
        #expect(chunks == ["T. A", "kept"])
    }

    @Test func capsAtMaxChunks() {
        let sections = (0 ..< 5).map { Chunker.Section(kind: "discussion", heading: nil, contentText: "body\($0)") }
        let chunks = Chunker.chunkDocument(
            title: "T", abstractText: nil, headings: nil, sections: sections, maxChunks: 3)
        #expect(chunks == ["T", "body0", "body1"])
    }

    @Test func emptyBodyAfterTrimIsSkipped() {
        let chunks = Chunker.chunkDocument(
            title: "T", abstractText: nil, headings: nil,
            sections: [Chunker.Section(kind: "discussion", heading: "H", contentText: "   \n  ")])
        #expect(chunks == ["T"])
    }
}
