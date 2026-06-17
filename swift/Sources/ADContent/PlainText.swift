public struct PlainTextSpans {
  public var title: ByteSpan?
  public var abstractText: ByteSpan?
  public var declarationText: ByteSpan?
  public var headings: ByteSpan?

  public init(
    title: ByteSpan? = nil, abstractText: ByteSpan? = nil, declarationText: ByteSpan? = nil,
    headings: ByteSpan? = nil
  ) {
    self.title = title
    self.abstractText = abstractText
    self.declarationText = declarationText
    self.headings = headings
  }
}

public struct PlainSectionSpans {
  public var heading: ByteSpan?
  public var text: ByteSpan
  public var sortOrder: Double

  public init(heading: ByteSpan? = nil, text: ByteSpan, sortOrder: Double = 0) {
    self.heading = heading
    self.text = text
    self.sortOrder = sortOrder
  }
}

public enum PlainText {
  public static func render(
    document: PlainTextSpans, sections: [PlainSectionSpans],
    w: inout ByteWriter, out: inout [UInt8]
  ) {
    w.removeAll()
    var first = true
    func part(_ body: (inout ByteWriter) -> Void) {
      let sep = first ? 0 : 2
      if !first { w.append("\n\n") }
      let mark = w.count
      body(&w)
      if w.count == mark {
        w.truncate(to: w.count - sep)  // body contributed nothing — drop part
      } else {
        first = false
      }
    }

    for field in [document.title, document.abstractText, document.declarationText, document.headings] {
      if let field, !field.isEmpty {
        part { $0.append(span: field) }
      }
    }

    let order = sections.indices.sorted {
      sections[$0].sortOrder != sections[$1].sortOrder
        ? sections[$0].sortOrder < sections[$1].sortOrder
        : $0 < $1
    }
    for index in order {
      let section = sections[index]
      part { w in
        // [heading, contentText].filter(Boolean).join('\n') → trim → ||null
        let mark = w.count
        if let heading = section.heading, !heading.isEmpty {
          w.append(span: heading)
          if !section.text.isEmpty { w.append(0x0A) }
        }
        if !section.text.isEmpty { w.append(span: section.text) }
        w.trim(since: mark)
      }
    }

    ByteOps.finishDocument(w.bytes, into: &out, trailingNewline: false)
  }
}
