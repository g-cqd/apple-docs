import AppleDocsContent
import AppleDocsCore
import AppleDocsSources
import Testing

@Suite("HTML & Sample-Code source adapters (Guidelines, WWDC, SampleCode, SwiftOrg)")
struct CommunityAndAppleAdaptersTests {
    @Test func `GuidelinesAdapter splits #content-container into numbered sections with parent-child links`()
        async throws
    {
        let html = """
            <html><body>
            <div id="content-container">
              <h3 id="safety" data-sidenav="1. Safety">1. Safety</h3>
              <p>When people install an app from the App Store, they want to feel confident.</p>
              <ul>
                <li id="objectionable-content" data-sidenav="1.1 Objectionable Content">
                  <p>Apps should not include content that is offensive or upsetting.</p>
                </li>
              </ul>
            </div>
            </body></html>
            """
        let transport = RecordingTransport()
        transport.set(GuidelinesAdapter.guidelinesURL, body: html, etag: "\"g1\"")
        let client = UpstreamHTTPClient(transport: transport)
        let adapter = GuidelinesAdapter()
        let discovery = try await adapter.discover(client: client, full: false)
        #expect(discovery.keys.map(\.rawValue) == ["app-store-review/1", "app-store-review/1.1"])

        let sec1 = try await adapter.fetch(
            key: try DocumentKey("app-store-review/1"),
            previousETag: nil,
            client: client
        )
        guard case .modified(let payload, _, _) = sec1, let doc = payload.converted else {
            Issue.record("expected modified guideline section")
            return
        }
        #expect(doc.document.title == "1. Safety" && doc.document.role == "collection")
        #expect(doc.document.url == "https://developer.apple.com/app-store/review/guidelines/#safety")
        #expect(doc.relationships.map(\.toKey.rawValue) == ["app-store-review/1.1"])
    }

    @Test func `WWDCAdapter discovers Apple year index + ASCIIwwdc VTTs and normalizes both`() async throws {
        let transport = RecordingTransport()
        for year in WWDCAdapter.appleYears {
            let body =
                year == 2024
                ? #"<a href="/videos/play/wwdc2024/10001/" class="vc-card" data-filter-topics="SwiftUI | Design">Card</a>"#
                : ""
            transport.set("https://developer.apple.com/videos/wwdc\(year)/", body: body)
        }
        transport.set(
            "https://api.github.com/repos/ASCIIwwdc/wwdc-session-transcripts/git/trees/master?recursive=1",
            body: #"{"truncated":false,"tree":[{"path":"en/2019/204.vtt","type":"blob"}]}"#
        )
        transport.set(
            "https://developer.apple.com/videos/play/wwdc2024/10001/",
            body: """
                <html><body>
                <h1>What's new in SwiftUI</h1>
                <p>Build great apps across every Apple platform with the latest SwiftUI features.</p>
                <h2>Chapters</h2><ul><li>0:00 - Introduction</li></ul>
                <p>Welcome to What's new in SwiftUI for this year.</p>
                </body></html>
                """
        )
        transport.set(
            "https://raw.githubusercontent.com/ASCIIwwdc/wwdc-session-transcripts/master/en/2019/204.vtt",
            body: "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nIntroducing SwiftUI: Building Your First App"
        )

        let client = UpstreamHTTPClient(transport: transport)
        let adapter = WWDCAdapter()
        let discovery = try await adapter.discover(client: client, full: false)
        #expect(discovery.keys.map(\.rawValue).sorted() == ["wwdc/wwdc2019-204", "wwdc/wwdc2024-10001"])

        let k24 = try DocumentKey("wwdc/wwdc2024-10001")
        if case .modified(let p, _, _) = try await adapter.fetch(key: k24, previousETag: nil, client: client),
            let conv = p.converted
        {
            #expect(conv.document.title == "What's new in SwiftUI" && conv.document.kind == "wwdc-session")
            #expect(conv.document.sourceMetadataJSON?.contains("SwiftUI | Design") == true)
            #expect(conv.sections.contains { $0.heading == "Transcript" })
        } else {
            Issue.record("expected modified 2024 session")
        }

        let k19 = try DocumentKey("wwdc/wwdc2019-204")
        if case .modified(let p, _, _) = try await adapter.fetch(key: k19, previousETag: nil, client: client),
            let conv = p.converted
        {
            #expect(conv.document.sourceMetadataJSON?.contains("\"source\":\"asciiwwdc\"") == true)
            #expect(conv.sections.first?.contentText.contains("Introducing SwiftUI") == true)
        } else {
            Issue.record("expected modified 2019 session")
        }
    }

    @Test func `SampleCodeAdapter and SwiftOrgAdapter normalize metadata and Related Documentation links`()
        async throws
    {
        let transport = RecordingTransport()
        transport.set(
            "https://developer.apple.com/tutorials/data/documentation/swiftui/composing-swiftui-gestures.json",
            body: #"{"metadata":{"title":"Composing SwiftUI Gestures","role":"sampleCode"}}"#
        )
        transport.set(
            "https://swift.org/documentation",
            body:
                "<html><head><title>Documentation | Swift.org</title></head><body><main><p>Swift docs hub.</p></main></body></html>"
        )
        let client = UpstreamHTTPClient(transport: transport)

        let sample = SampleCodeAdapter()
        let sampleKey = try DocumentKey("sample-code/swiftui/composing-swiftui-gestures")
        if case .modified(let p, _, _) = try await sample.fetch(key: sampleKey, previousETag: nil, client: client),
            let conv = p.converted
        {
            #expect(conv.document.sourceType == .sampleCode && conv.document.kind == "sample-project")
            #expect(conv.document.framework == "swiftui")
            #expect(conv.document.url == "https://developer.apple.com/documentation/swiftui/composing-swiftui-gestures")
        } else {
            Issue.record("expected modified sample project")
        }

        let swiftOrg = SwiftOrgAdapter()
        let orgKey = try DocumentKey("swift-org/documentation")
        if case .modified(let p, _, _) = try await swiftOrg.fetch(key: orgKey, previousETag: nil, client: client),
            let conv = p.converted
        {
            #expect(conv.document.title == "Documentation")
            #expect(conv.relationships.contains { $0.toKey.rawValue == "swift-book/the-swift-programming-language" })
            #expect(conv.sections.contains { $0.heading == "Related Documentation" })
        } else {
            Issue.record("expected modified swift-org page")
        }
    }
}
