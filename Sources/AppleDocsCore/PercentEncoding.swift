/// Byte-wise percent-encoding (`%XX`, uppercase hex) over UTF-8.
public enum PercentEncoding {
    /// `text` with every UTF-8 byte for which `isAllowed` is false encoded as `%XX`.
    public static func encode(_ text: String, keeping isAllowed: (UInt8) -> Bool) -> String {
        var out = ""
        out.reserveCapacity(text.utf8.count)
        for byte in text.utf8 {
            if isAllowed(byte) {
                out.unicodeScalars.append(Unicode.Scalar(byte))
            } else {
                out +=
                    "%" + String(byte >> 4, radix: 16, uppercase: true) + String(byte & 0xF, radix: 16, uppercase: true)
            }
        }
        return out
    }

    /// ASCII letters and digits.
    public static func isAlphanumeric(_ byte: UInt8) -> Bool {
        (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39)
    }
}
