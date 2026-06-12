// Port of src/content/render-text.js renderPlainText — the FTS body text
// (normative JS until the phase-5 kill).

public struct PlainTextDocument: Sendable {
  public var title: String?
  public var abstractText: String?
  public var declarationText: String?
  public var headings: String?

  public init(
    title: String? = nil, abstractText: String? = nil, declarationText: String? = nil,
    headings: String? = nil
  ) {
    self.title = title
    self.abstractText = abstractText
    self.declarationText = declarationText
    self.headings = headings
  }
}

public struct PlainTextSection: Sendable {
  public var heading: String?
  public var contentText: String
  public var sortOrder: Double

  public init(heading: String? = nil, contentText: String = "", sortOrder: Double = 0) {
    self.heading = heading
    self.contentText = contentText
    self.sortOrder = sortOrder
  }
}

public enum PlainText {
  public static func render(document: PlainTextDocument, sections: [PlainTextSection]) -> String {
    let ordered = sections.enumerated().sorted {
      $0.element.sortOrder != $1.element.sortOrder
        ? $0.element.sortOrder < $1.element.sortOrder
        : $0.offset < $1.offset
    }.map(\.element)

    var parts: [String] = []
    for field in [document.title, document.abstractText, document.declarationText, document.headings] {
      if let field, !field.isEmpty { parts.append(field) }
    }
    for section in ordered {
      var body: [String] = []
      if let heading = section.heading, !heading.isEmpty { body.append(heading) }
      if !section.contentText.isEmpty { body.append(section.contentText) }
      let joined = JsString.trim(body.joined(separator: "\n"))
      if !joined.isEmpty { parts.append(joined) }
    }
    return JsString.trim(JsString.collapseBlankRuns(parts.joined(separator: "\n\n")))
  }
}
