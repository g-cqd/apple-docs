import AemiJSONCore
import AppleDocsOutput
import OrderedCollections
import Testing

@Suite("JavaScriptJSON")
struct JavaScriptJSONTests {
    @Test func `stringifies exactly like JSON.stringify`() {
        let value: JSONValue = .object([
            "a": .string("x\"y\\\n\u{01}é/\u{2028}\t"),
            "b": .array([
                .int(1), .number(2.5), .null, .bool(true), .number(-0.0), .number(1e21), .number(0.000001),
                .int(123_456_789_012)
            ]),
            "c": .object([:]),
            "d": .array([])
        ])
        // Expected text produced by `bun -e 'console.log(JSON.stringify(…))'`.
        let expected =
            #"{"a":"x\"y\\\n\u0001é/\#u{2028}\t","b":[1,2.5,null,true,0,1e+21,0.000001,123456789012],"c":{},"d":[]}"#
        #expect(JavaScriptJSON.stringify(value) == expected)
        #expect(JavaScriptJSON.length(.string("é😀")) == 5)
        #expect(JavaScriptJSON.length(value) == JavaScriptJSON.stringify(value).utf16.count)
        #expect(JavaScriptJSON.length(.array([])) == 2 && JavaScriptJSON.length(.object([:])) == 2)
    }
}
