import ADJSONCore

// Minimal hand-framed streaming JSON writer (no Foundation): tracks open-container state and inserts
// commas between object members / array elements automatically. String escaping is delegated to
// ADJSON's `JSONOutput.appendString` — the single JSON.stringify-identical escaper — so the escape
// table is not re-maintained here.

struct JSONWriter {
    var bytes: [UInt8] = []
    private var hasContent: [Bool] = []  // per open container
    private var afterKey = false

    private mutating func beforeValue() {
        if afterKey {
            afterKey = false
            return
        }
        if let last = hasContent.last, last { bytes.append(UInt8(ascii: ",")) }
        if !hasContent.isEmpty { hasContent[hasContent.count - 1] = true }
    }

    mutating func openObject() {
        beforeValue()
        bytes.append(UInt8(ascii: "{"))
        hasContent.append(false)
    }
    mutating func closeObject() {
        bytes.append(UInt8(ascii: "}"))
        hasContent.removeLast()
    }
    mutating func openArray() {
        beforeValue()
        bytes.append(UInt8(ascii: "["))
        hasContent.append(false)
    }
    mutating func closeArray() {
        bytes.append(UInt8(ascii: "]"))
        hasContent.removeLast()
    }

    mutating func key(_ k: String) {
        if let last = hasContent.last, last { bytes.append(UInt8(ascii: ",")) }
        if !hasContent.isEmpty { hasContent[hasContent.count - 1] = true }
        writeString(k)
        bytes.append(UInt8(ascii: ":"))
        afterKey = true
    }

    mutating func string(_ s: String) {
        beforeValue()
        writeString(s)
    }
    mutating func stringOrNull(_ s: String?) {
        beforeValue()
        if let s { writeString(s) } else { bytes.append(contentsOf: "null".utf8) }
    }
    mutating func int(_ n: Int) {
        beforeValue()
        bytes.append(contentsOf: String(n).utf8)
    }
    mutating func bool(_ b: Bool) {
        beforeValue()
        bytes.append(contentsOf: (b ? "true" : "false").utf8)
    }
    mutating func raw(_ s: String) {
        beforeValue()
        bytes.append(contentsOf: s.utf8)
    }
    /// Emits the raw JSON string verbatim (a stored platforms_json array), or []
    /// when nil — JSON.stringify(JSON.parse(x)) is identity for the compact JSON
    /// the pipeline stores.
    mutating func rawOrEmptyArray(_ s: String?) {
        beforeValue()
        if let s { bytes.append(contentsOf: s.utf8) } else { bytes.append(contentsOf: "[]".utf8) }
    }

    // Delegates to ADJSON's single JSON.stringify-identical escaper (quotes, backslash, the standard
    // short escapes, and u-escapes for other C0 control bytes; UTF-8 passes through unchanged).
    private mutating func writeString(_ s: String) {
        JSONOutput.appendString(s, to: &bytes)
    }
}
