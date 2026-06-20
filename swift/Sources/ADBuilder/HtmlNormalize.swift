// HtmlNormalize — map an extracted HTML page (ADHTMLCore's `HTMLDocument.extract`) to a
// `NormalizedPage`. The native port of the JS crawl's `parseHtmlToNormalized`
// (src/content/parse-html.js): the heavy lifting (parse → DOM → container → sections → Markdown)
// now lives in ADHTML; this is the thin, pure adapter-facing mapping the HTML-scrape adapters
// (guidelines / swift-org / apple-archive) call from their `normalize`.

import ADHTMLCore
import Foundation

public enum HtmlNormalize {
    /// Parse an HTML page into the canonical normalized model.
    ///
    /// - Parameters:
    ///   - html: the page source.
    ///   - key: the canonical path key (e.g. `swift/generics`).
    ///   - sourceType: the adapter's source tag.
    ///   - kind/framework/url/language/sourceMetadata: document fields the adapter supplies.
    ///   - containerSelector: optional content-container selector (`tag` / `.class` / `#id`).
    ///   - preserveStructure: render section bodies as Markdown (true) or plain text (false).
    public static func parse(
        _ html: String,
        key: String,
        sourceType: String? = nil,
        kind: String? = nil,
        framework: String? = nil,
        url: String? = nil,
        language: String? = nil,
        sourceMetadata: String? = nil,
        containerSelector: String? = nil,
        preserveStructure: Bool = false,
        linkResolver: ((String) -> String?)? = nil
    ) -> NormalizedPage {
        if let target = detectRedirect(html) {
            return redirectPage(key: key, target: target, sourceType: sourceType, framework: framework, language: language, sourceMetadata: sourceMetadata)
        }

        let extracted = HTMLDocument.extract(
            html, containerSelector: containerSelector, preserveStructure: preserveStructure,
            linkResolver: linkResolver)
        let description = extracted.description

        // abstractText: the description, else the first paragraph of the lead section.
        var abstractText = description
        if abstractText == nil, let lead = extracted.sections.first?.content, !lead.isEmpty {
            let firstParagraph = lead.components(separatedBy: "\n\n").first?.trimmingCharacters(in: .whitespacesAndNewlines)
            abstractText = (firstParagraph?.isEmpty == false) ? firstParagraph : nil
        }

        // headings: space-joined section headings (for FTS).
        let headingTexts = extracted.sections.compactMap(\.heading)
        let headings = headingTexts.isEmpty ? nil : headingTexts.joined(separator: " ")

        let document = NormalizedDocument(
            sourceType: sourceType, key: key, title: extracted.title, kind: kind, framework: framework,
            url: url, language: language, abstractText: abstractText, headings: headings,
            sourceMetadata: sourceMetadata)

        var sections: [NormalizedSection] = []
        var order = 0
        if let description {
            sections.append(
                NormalizedSection(
                    sectionKind: "abstract", heading: nil, contentText: description, sortOrder: order))
            order += 1
        }
        for section in extracted.sections {
            // Skip the lead section when it's already captured as the abstract.
            if section.heading == nil, description != nil, order == 1 { continue }
            if section.content.isEmpty, section.heading == nil { continue }
            sections.append(
                NormalizedSection(
                    sectionKind: section.heading == nil ? "abstract" : "discussion",
                    heading: section.heading,
                    contentText: section.content.isEmpty ? nil : section.content,
                    sortOrder: order))
            order += 1
        }

        return NormalizedPage(document: document, sections: sections)
    }

    /// A `<meta http-equiv="refresh" content="0; url=…">` redirect target, if the page is a stub.
    static func detectRedirect(_ html: String) -> String? {
        for meta in HTMLNode.parse(html).elements(tag: "meta") {
            guard meta.attribute("http-equiv")?.lowercased() == "refresh",
                let content = meta.attribute("content")
            else { continue }
            // content is "<seconds>; url=<target>".
            guard let range = content.range(of: "url=", options: .caseInsensitive) else { continue }
            let target = content[range.upperBound...].trimmingCharacters(
                in: CharacterSet(charactersIn: " '\"")).trimmingCharacters(in: .whitespacesAndNewlines)
            if !target.isEmpty { return target }
        }
        return nil
    }

    private static func redirectPage(
        key: String, target: String, sourceType: String?, framework: String?, language: String?,
        sourceMetadata: String?
    ) -> NormalizedPage {
        let document = NormalizedDocument(
            sourceType: sourceType, key: key, title: "Moved to \(target)", kind: "redirect",
            framework: framework, url: target, language: language,
            abstractText: "This page has moved. The current location is \(target).",
            sourceMetadata: sourceMetadata)
        let section = NormalizedSection(
            sectionKind: "discussion", heading: "Page Moved",
            contentText:
                "This page is no longer maintained at its original location. The current canonical location is:\n\n[\(target)](\(target))",
            sortOrder: 0)
        return NormalizedPage(document: document, sections: [section])
    }
}
