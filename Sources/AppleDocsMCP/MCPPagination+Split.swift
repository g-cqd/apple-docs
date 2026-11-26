/// Oversized-section splitting (`splitOversizedSection`, `splitText`, `groupChunks`, `splitByCharacterWindow`,
/// `sliceTextAtBoundary`, `skipWhitespace`).
extension MCPPagination {
    static func splitOversized(_ section: DocumentSectionRecordJS, target: Int) -> [DocumentSectionRecordJS] {
        let text = section.text
        guard text.length > minSectionFragmentChars else { return [section] }
        let effective = max(minSectionFragmentChars, min(target, max(text.length - 1, 1)))
        let pieces = groupChunks(splitText(text), effective)
        if pieces.count <= 1 { return characterWindows(text, effective).map(section.withText) }
        return pieces.map(section.withText)
    }

    static func splitText(_ text: JSText) -> [JSText] {
        let paragraphs = split(text, onNewlineRunsOfAtLeast: 2).map { $0.trimmed() }.filter { $0.length > 0 }
        if paragraphs.count > 1 { return paragraphs }
        let lines = split(text, onNewlineRunsOfAtLeast: 1).map { $0.trimmed() }.filter { $0.length > 0 }
        if lines.count > 1 { return lines }
        return [text.trimmed()]
    }

    /// `text.split(/\n{n,}/)` (with n = 1 meaning a plain `split('\n')`).
    private static func split(_ text: JSText, onNewlineRunsOfAtLeast minimum: Int) -> [JSText] {
        var parts: [JSText] = []
        var start = 0
        var index = 0
        while index < text.length {
            guard text.units[index] == 0x0A else {
                index += 1
                continue
            }
            var runEnd = index
            while runEnd < text.length, text.units[runEnd] == 0x0A { runEnd += 1 }
            if minimum == 1 {
                parts.append(text.slice(start, index))
                for _ in 1 ..< (runEnd - index) { parts.append(JSText("")) }
                start = runEnd
            } else if runEnd - index >= minimum {
                parts.append(text.slice(start, index))
                start = runEnd
            }
            index = runEnd
        }
        parts.append(text.slice(start))
        return parts
    }

    static func groupChunks(_ chunks: [JSText], _ target: Int) -> [JSText] {
        var groups: [JSText] = []
        var buffer: [JSText] = []
        var bufferLength = 0
        let separator = JSText("\n\n")
        func flush() -> JSText { JSText(units: ArraySlice(buffer.map(\.units).joined(separator: separator.units))) }
        for chunk in chunks {
            let gap = buffer.isEmpty ? 0 : 2
            if bufferLength + gap + chunk.length <= target || buffer.isEmpty {
                buffer.append(chunk)
                bufferLength += gap + chunk.length
                continue
            }
            groups.append(flush())
            buffer = [chunk]
            bufferLength = chunk.length
        }
        if !buffer.isEmpty { groups.append(flush()) }
        return groups
    }

    static func characterWindows(_ text: JSText, _ target: Int) -> [JSText] {
        var parts: [JSText] = []
        var start = 0
        while start < text.length {
            start = skipWhitespace(text, start)
            if start >= text.length { break }
            let slice = sliceAtBoundary(text, start, min(text.length, start + target))
            parts.append(slice.text)
            start = slice.end
        }
        return parts.filter { $0.length > 0 }
    }

    static func sliceAtBoundary(_ text: JSText, _ start: Int, _ end: Int) -> (text: JSText, end: Int) {
        if end >= text.length { return (text.slice(start).trimmed(), text.length) }
        let slice = text.slice(start, end)
        let boundary = max(
            slice.lastIndexOf(JSText("\n\n")),
            slice.lastIndexOf(JSText("\n")),
            slice.lastIndexOf(JSText(" "))
        )
        if boundary <= min(24, slice.length / 4) { return (slice.trimmed(), end) }
        return (slice.slice(0, boundary).trimmed(), start + boundary)
    }

    static func skipWhitespace(_ text: JSText, _ start: Int) -> Int {
        var index = start
        while index < text.length, JSText.isWhitespace(text.units[index]) { index += 1 }
        return index
    }
}
