// Gate for the WWDC adapter (port of src/sources/wwdc.js): the two-corpora split —
// Apple session HTML scrape (year >= 2020, `.json` payload) and ASCIIwwdc `.vtt`
// transcripts (1997–2019, `.markdown` payload). Pure normalize + the VTT/HTML
// scrapers are exercised directly; discover/fetch run over the in-memory HTTP stub.

import Foundation
import HTTPTypes
import Testing

@testable import ADBuilder

@Suite("WwdcAdapter — Apple-HTML + ASCIIwwdc-VTT")
struct WwdcAdapterTests {
    // MARK: - fixtures

    private static let sessionHTML = """
        <html><head><title>Ignore me</title></head><body>
        <nav><a href="/foo">nav junk that must be stripped out</a></nav>
        <h1>Meet SwiftData</h1>
        <p>SwiftData is a powerful new framework for data modeling and management.</p>
        <h2>Chapters</h2>
        <ul><li>0:00 - Introduction</li><li>2:30 - Modeling data</li></ul>
        <p>Welcome to the session, today we will explore the SwiftData framework in depth.</p>
        <p>You can define your models using the new Swift macros provided by the framework.</p>
        </body></html>
        """

    private static let indexHTML = """
        <div class="grid">
        <a href="/videos/play/wwdc2024/10001/" class="vc-card" data-filter-topics="SwiftUI &amp; UI Frameworks">Meet SwiftData</a>
        <a href="/videos/play/wwdc2024/10002/" class="vc-card" data-filter-topics="Developer Tools">What's new in Xcode</a>
        </div>
        """

    private static let treeJSON = """
        {"tree":[\
        {"path":"en/1998/400.vtt","type":"blob","sha":"a"},\
        {"path":"en/2005/100.vtt","type":"blob","sha":"b"},\
        {"path":"en/2020/999.vtt","type":"blob","sha":"c"},\
        {"path":"en/1998/notes.md","type":"blob","sha":"d"},\
        {"path":"en/1998","type":"tree","sha":"e"}]}
        """

    /// Encode a scraped-session `.json` payload (the shape `fetch` produces).
    private func applePayload(
        title: String?, description: String?, chapters: [String], transcript: String?, track: String?
    ) -> SourcePayload {
        var dict: [String: Any] = [
            "title": title ?? NSNull(), "description": description ?? NSNull(), "chapters": chapters,
            "transcript": transcript ?? NSNull(), "year": 2024, "sessionId": "10001", "format": "html"
        ]
        if let track { dict["track"] = track }
        return .json(Array(try! JSONSerialization.data(withJSONObject: dict)))
    }

    // MARK: - keys

    @Test("parseWwdcKey / buildKey / buildAsciiwwdcPath / parseAsciiwwdcPath")
    func keys() {
        #expect(WwdcAdapter.parseWwdcKey("wwdc/wwdc2024-10001")?.year == 2024)
        #expect(WwdcAdapter.parseWwdcKey("wwdc/wwdc2024-10001")?.sessionId == "10001")
        #expect(WwdcAdapter.parseWwdcKey("wwdc/2024-10001") == nil)
        #expect(WwdcAdapter.parseWwdcKey("other/wwdc2024-10001") == nil)
        #expect(WwdcAdapter.buildKey(year: 1998, sessionId: "400") == "wwdc/wwdc1998-400")
        #expect(WwdcAdapter.buildAsciiwwdcPath(year: 1998, sessionId: "400") == "en/1998/400.vtt")
        #expect(WwdcAdapter.parseAsciiwwdcPath("en/1998/400.vtt")?.year == 1998)
        #expect(WwdcAdapter.parseAsciiwwdcPath("en/1998/400.vtt")?.sessionId == "400")
        #expect(WwdcAdapter.parseAsciiwwdcPath("fr/1998/400.vtt") == nil)
        #expect(WwdcAdapter.parseAsciiwwdcPath("en/1998/notes.md") == nil)
    }

    // MARK: - Apple HTML scraping

    @Test("parseSessionHtml extracts title, description, chapters, transcript (nav stripped)")
    func parseSessionHtml() {
        let payload = WwdcAdapter.parseSessionHtml(Self.sessionHTML, year: 2024, sessionId: "10001")
        #expect(payload["title"] as? String == "Meet SwiftData")
        #expect((payload["description"] as? String)?.hasPrefix("SwiftData is a powerful") == true)
        #expect(payload["chapters"] as? [String] == ["0:00 - Introduction", "2:30 - Modeling data"])
        let transcript = payload["transcript"] as? String
        #expect(transcript?.contains("Welcome to the session") == true)
        #expect(transcript?.contains("You can define your models") == true)
        // The description paragraph and the nav text never leak into the transcript.
        #expect(transcript?.contains("SwiftData is a powerful") == false)
        #expect(transcript?.contains("nav junk") == false)
    }

    @Test("extractSessionIds / extractSessionTracks read the year-index cards")
    func yearIndexScrape() {
        #expect(WwdcAdapter.extractSessionIds(Self.indexHTML, year: 2024) == ["10001", "10002"])
        let tracks = WwdcAdapter.extractSessionTracks(Self.indexHTML, year: 2024)
        #expect(tracks["10001"] == "SwiftUI & UI Frameworks")  // entities decoded
        #expect(tracks["10002"] == "Developer Tools")
    }

    @Test("decodeHtmlEntities decodes &amp; last (double-escape round-trip)")
    func entities() {
        #expect(WwdcAdapter.decodeHtmlEntities("a &amp;lt; b") == "a &lt; b")
        #expect(WwdcAdapter.decodeHtmlEntities("&lt;tag&gt; &quot;x&quot; &#39;y&#39;") == "<tag> \"x\" 'y'")
    }

    // MARK: - Apple normalize (pure)

    @Test("normalize (Apple) builds the session document, sections, and source metadata")
    func normalizeApple() throws {
        let payload = applePayload(
            title: "Meet SwiftData", description: "SwiftData is great and powerful for data.",
            chapters: ["0:00 Intro", "2:00 Details"], transcript: "Line one of transcript.\n\nLine two.",
            track: "SwiftUI & UI Frameworks")
        let page = try WwdcAdapter().normalize("wwdc/wwdc2024-10001", payload)

        #expect(page.document.title == "Meet SwiftData")
        #expect(page.document.sourceType == "wwdc")
        #expect(page.document.kind == "wwdc-session")
        #expect(page.document.role == "article")
        #expect(page.document.framework == "wwdc")
        #expect(page.document.url == "https://developer.apple.com/videos/play/wwdc2024/10001/")
        #expect(page.document.abstractText == "SwiftData is great and powerful for data.")
        #expect(page.document.urlDepth == 1)
        #expect(
            page.document.sourceMetadata
                == #"{"year":2024,"sessionId":"10001","source":"apple","track":"SwiftUI & UI Frameworks"}"#)

        #expect(page.sections.count == 3)
        #expect(page.sections[0].sectionKind == "abstract")
        #expect(page.sections[0].heading == nil)
        #expect(page.sections[1].sectionKind == "content")
        #expect(page.sections[1].heading == "Chapters")
        #expect(page.sections[1].contentText == "0:00 Intro\n2:00 Details")
        #expect(page.sections[2].sectionKind == "content")
        #expect(page.sections[2].heading == "Transcript")
        #expect(page.sections[2].contentText == "Line one of transcript.\n\nLine two.")
        #expect(page.sections[2].contentJson == nil)
        #expect(page.relationships.isEmpty)
    }

    @Test("normalize (Apple) falls back to the session number and omits an absent track")
    func normalizeAppleFallback() throws {
        let payload = applePayload(title: nil, description: nil, chapters: [], transcript: nil, track: nil)
        let page = try WwdcAdapter().normalize("wwdc/wwdc2024-10001", payload)
        #expect(page.document.title == "WWDC2024 Session 10001")
        #expect(page.document.abstractText == nil)
        #expect(page.document.sourceMetadata == #"{"year":2024,"sessionId":"10001","source":"apple"}"#)
        #expect(page.sections.isEmpty)
    }

    // MARK: - ASCIIwwdc VTT normalize (pure)

    @Test("normalizeAsciiwwdcTranscript strips VTT scaffolding, tags, and dedupes lines")
    func vttNormalizer() {
        let vtt = """
            WEBVTT

            1
            00:00:01.000 --> 00:00:03.000
            Hello <v Speaker>everyone</v>

            2
            00:00:03.000 --> 00:00:05.000
            Hello <v Speaker>everyone</v>

            NOTE editorial aside
            Welcome to WWDC
            """
        #expect(WwdcAdapter.normalizeAsciiwwdcTranscript(vtt) == "Hello everyone\nWelcome to WWDC")
    }

    @Test("extractAsciiwwdcTitle uses a heading line, else the session number")
    func asciiwwdcTitle() {
        #expect(
            WwdcAdapter.extractAsciiwwdcTitle("Understanding Concurrency\nintro\n", year: 2010, sessionId: "5")
                == "Understanding Concurrency")
        #expect(
            WwdcAdapter.extractAsciiwwdcTitle("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi", year: 2010, sessionId: "5")
                == "WWDC2010 Session 5")
        #expect(
            WwdcAdapter.extractAsciiwwdcTitle("00:00:01.000 --> 00:00:02.000\nHi", year: 2010, sessionId: "5")
                == "WWDC2010 Session 5")
        // A leading MM:SS-style line is treated as timing, not a title.
        #expect(
            WwdcAdapter.extractAsciiwwdcTitle("12:34 opening remarks", year: 2010, sessionId: "5")
                == "WWDC2010 Session 5")
    }

    @Test("normalize (ASCIIwwdc) builds the transcript document + source metadata")
    func normalizeAsciiwwdc() throws {
        let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello everyone\n\nWelcome to WWDC\n"
        let page = try WwdcAdapter().normalize("wwdc/wwdc1998-400", .markdown(vtt))
        #expect(page.document.title == "WWDC1998 Session 400")
        #expect(page.document.kind == "wwdc-session")
        #expect(page.document.framework == "wwdc")
        #expect(page.document.url == "https://developer.apple.com/videos/play/wwdc1998/400/")
        #expect(page.document.abstractText == nil)
        #expect(page.document.sourceMetadata == #"{"year":1998,"sessionId":"400","source":"asciiwwdc"}"#)
        #expect(page.sections.count == 1)
        #expect(page.sections[0].sectionKind == "content")
        #expect(page.sections[0].heading == "Transcript")
        #expect(page.sections[0].contentText == "Hello everyone\nWelcome to WWDC")
        #expect(page.relationships.isEmpty)
    }

    // MARK: - discover / fetch (over the HTTP stub)

    @Test("discover merges Apple index keys + ASCIIwwdc tree keys under the wwdc root")
    func discover() async throws {
        let context = SourceContext(
            client: StubHTTPClient { request in
                let path = request.head.path ?? ""
                if path.contains("/git/trees/") { return httpResponse(200, body: Self.treeJSON) }
                if path.contains("/videos/wwdc2024/") { return httpResponse(200, body: Self.indexHTML) }
                if path.contains("/videos/wwdc") { return httpResponse(200, body: "<html></html>") }
                return httpResponse(404)
            }, rateLimiter: instantRateLimiter())
        let result = try await WwdcAdapter().discover(context)

        #expect(result.keys.contains("wwdc/wwdc2024-10001"))
        #expect(result.keys.contains("wwdc/wwdc2024-10002"))
        #expect(result.keys.contains("wwdc/wwdc1998-400"))
        #expect(result.keys.contains("wwdc/wwdc2005-100"))
        // en/2020/999.vtt is past the ASCIIwwdc range, and the 2020 Apple index is empty.
        #expect(!result.keys.contains("wwdc/wwdc2020-999"))
        #expect(result.roots.first?.slug == "wwdc")
        #expect(result.roots.first?.displayName == "WWDC Sessions")
        #expect(result.roots.first?.kind == "collection")
    }

    @Test("fetch (Apple) scrapes the session page and attaches the year-index track")
    func fetchApple() async throws {
        let context = SourceContext(
            client: StubHTTPClient { request in
                let path = request.head.path ?? ""
                if path.contains("/videos/play/wwdc2024/10001") {
                    return httpResponse(200, body: Self.sessionHTML, headerFields: [.eTag: "\"v1\""])
                }
                if path.contains("/videos/wwdc2024/") { return httpResponse(200, body: Self.indexHTML) }
                return httpResponse(404)
            }, rateLimiter: instantRateLimiter())
        let result = try await WwdcAdapter().fetch("wwdc/wwdc2024-10001", context)

        #expect(result.etag == "\"v1\"")
        guard case .json(let bytes) = result.payload else {
            Issue.record("expected a json payload")
            return
        }
        let object = try JSONSerialization.jsonObject(with: Data(bytes))
        let json = try #require(object as? [String: Any])
        #expect(json["title"] as? String == "Meet SwiftData")
        #expect(json["track"] as? String == "SwiftUI & UI Frameworks")

        // End-to-end: the fetched payload normalizes with the track in source metadata.
        let page = try WwdcAdapter().normalize("wwdc/wwdc2024-10001", result.payload)
        #expect(page.document.title == "Meet SwiftData")
        #expect(page.document.sourceMetadata?.contains(#""track":"SwiftUI & UI Frameworks""#) == true)
    }

    @Test("fetch (ASCIIwwdc) returns the raw .vtt as a markdown payload")
    func fetchAsciiwwdc() async throws {
        let vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n"
        let context = SourceContext(
            client: StubHTTPClient { request in
                (request.head.path ?? "").hasSuffix(".vtt")
                    ? httpResponse(200, body: vtt, headerFields: [.eTag: "\"e1\""]) : httpResponse(404)
            }, rateLimiter: instantRateLimiter())
        let result = try await WwdcAdapter().fetch("wwdc/wwdc1998-400", context)

        #expect(result.etag == "\"e1\"")
        guard case .markdown(let text) = result.payload else {
            Issue.record("expected a markdown payload")
            return
        }
        #expect(text == vtt)
    }
}
