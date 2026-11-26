import AemiJSONCore
import AppleDocsCore
import OrderedCollections

/// A coerced lookup section (`{sectionKind, heading, contentText, sortOrder}`) as the paginator handles it.
struct DocumentSectionRecordJS {
    var json: JSONValue
    var text: JSText

    init(json: JSONValue) {
        self.json = json
        let content: String? =
            if case .object(let object) = json, case .string(let text)? = object["contentText"] { text } else { nil }
        self.text = JSText(content ?? "")
    }

    var record: DocumentSectionRecord {
        guard case .object(let object) = json else { return DocumentSectionRecord(sectionKind: "", contentText: "") }
        let order: Int = if case .int(let value)? = object["sortOrder"] { Int(value) } else { 0 }
        let heading: String? = if case .string(let value)? = object["heading"] { value } else { nil }
        let kind: String = if case .string(let value)? = object["sectionKind"] { value } else { "" }
        return DocumentSectionRecord(sectionKind: kind, heading: heading, contentText: text.string, sortOrder: order)
    }

    /// `{...section, contentText, contentJson: null}`.
    func withText(_ newText: JSText) -> DocumentSectionRecordJS {
        guard case .object(var object) = json else { return self }
        object["contentText"] = .string(newText.string)
        object["contentJson"] = .null
        return DocumentSectionRecordJS(json: .object(object))
    }
}
