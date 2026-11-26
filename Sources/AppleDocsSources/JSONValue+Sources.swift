import AemiJSONCore

extension JSONValue {
    static func jsonString(_ value: Self) -> String {
        (try? value.encodedBytes()).map { String(decoding: $0, as: UTF8.self) } ?? "null"
    }
}
