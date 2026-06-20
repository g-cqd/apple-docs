// Content stream (content-stream.js) — the CGContext-operator interpreter stage
// of the SF-Symbol PDF→SVG converter. Tokenizes the decoded content stream and
// folds the operator subset into a flat list of `Fill`s. Leans on the shared
// `PdfScan` byte helpers; the tokenizer's own grammar classes (`isAlpha`,
// `isOpByte`, …) stay file-private here since they are the content-stream
// token grammar, not general PDF scanning.

import Foundation

// MARK: - Content-stream model

/// One path command: an operator letter (`M`/`L`/`C`/`Z`) and its flipped-later
/// coordinate args (`Z` carries none).
struct PathCommand {
    let op: String
    let args: [Double]
}

/// A subpath = an ordered command list (starts with `M`).
struct Subpath {
    var commands: [PathCommand]
}

/// A fill record: its subpaths, the alpha in force when it was painted, and the
/// fill rule (`nonzero`/`evenodd`).
struct Fill {
    var subpaths: [Subpath]
    let alpha: Double
    let fillRule: String
}

// MARK: - Content stream (content-stream.js)

enum ContentStream {
    private enum Operand {
        case number(Double)
        case name(String)
    }
    private enum Token {
        case number(Double)
        case name(String)
        case op(String)
    }

    /// Mutable interpreter state for `parse` — the operand buffer, accumulated
    /// fills, the in-progress path, the current point, and the alpha (`q`/`Q`)
    /// stack. The per-operator behaviour is split across three grouped handlers
    /// (`handleStateOp`/`handlePathOp`/`handleFillOp`) routed by `dispatch`,
    /// each byte-for-byte the prior inline `switch` arm.
    private struct Interp {
        var operands: [Operand] = []
        var fills: [Fill] = []
        var path: [Subpath] = []
        var currentX = 0.0
        var currentY = 0.0
        var stack: [Double] = [1.0]  // alpha stack; top() is last

        func topAlpha() -> Double { stack[stack.count - 1] }
        mutating func setTopAlpha(_ value: Double) { stack[stack.count - 1] = value }

        func num(_ i: Int) -> Double {
            guard i >= 0, i < operands.count, case .number(let n) = operands[i] else { return .nan }
            return n
        }

        mutating func closeFill(_ fillRule: String) {
            if path.isEmpty { return }
            fills.append(Fill(subpaths: path, alpha: topAlpha(), fillRule: fillRule))
            path = []
        }
        mutating func startSubpath(_ x: Double, _ y: Double) {
            path.append(Subpath(commands: [PathCommand(op: "M", args: [x, y])]))
            currentX = x
            currentY = y
        }
        mutating func appendCommand(_ cmd: PathCommand) {
            if path.isEmpty { return }
            path[path.count - 1].commands.append(cmd)
        }

        /// Route one operator to its group. Unknown operators are ignored (the JS
        /// `default` no-op); the caller clears the operand list after dispatch.
        mutating func dispatch(_ op: String, alphaByName: [String: Double]) {
            switch op {
                case "q", "Q", "gs", "cm", "cs", "sc", "scn", "CS", "SC", "SCN", "rg", "RG", "g", "G", "k", "K":
                    handleStateOp(op, alphaByName: alphaByName)
                case "m", "l", "c", "v", "y", "re", "h":
                    handlePathOp(op)
                case "f", "F", "f*", "B", "B*", "b", "b*", "n", "S", "s":
                    handleFillOp(op)
                default:
                    break
            }
        }

        /// Graphics-state ops: the `q`/`Q` alpha stack, `gs` ExtGState alpha lookup,
        /// and the colour/`cm` no-ops (parsed but ignored, matching the JS).
        mutating func handleStateOp(_ op: String, alphaByName: [String: Double]) {
            switch op {
                case "q":
                    stack.append(topAlpha())
                case "Q":
                    if stack.count > 1 { stack.removeLast() }
                case "gs":
                    if case .name(let name)? = operands.first, name.hasPrefix("/") {
                        let key = String(name.dropFirst())
                        if let alpha = alphaByName[key] { setTopAlpha(alpha) }
                    }
                default:
                    break  // cm + cs/sc/scn/CS/SC/SCN/rg/RG/g/G/k/K — parsed, no geometry effect
            }
        }

        /// Path-building ops: move/line/curve (`m`/`l`/`c`/`v`/`y`), the `re`
        /// rectangle expansion, and `h` close.
        mutating func handlePathOp(_ op: String) {
            switch op {
                case "m":
                    startSubpath(num(0), num(1))
                case "l":
                    appendCommand(PathCommand(op: "L", args: [num(0), num(1)]))
                    currentX = num(0)
                    currentY = num(1)
                case "c":
                    appendCommand(
                        PathCommand(op: "C", args: [num(0), num(1), num(2), num(3), num(4), num(5)]))
                    currentX = num(4)
                    currentY = num(5)
                case "v":
                    appendCommand(
                        PathCommand(
                            op: "C", args: [currentX, currentY, num(0), num(1), num(2), num(3)]))
                    currentX = num(2)
                    currentY = num(3)
                case "y":
                    appendCommand(
                        PathCommand(op: "C", args: [num(0), num(1), num(2), num(3), num(2), num(3)]))
                    currentX = num(2)
                    currentY = num(3)
                case "re":
                    let x = num(0)
                    let y = num(1)
                    let w = num(2)
                    let h = num(3)
                    path.append(
                        Subpath(commands: [
                            PathCommand(op: "M", args: [x, y]),
                            PathCommand(op: "L", args: [x + w, y]),
                            PathCommand(op: "L", args: [x + w, y + h]),
                            PathCommand(op: "L", args: [x, y + h]),
                            PathCommand(op: "Z", args: [])
                        ]))
                    currentX = x
                    currentY = y
                case "h":
                    appendCommand(PathCommand(op: "Z", args: []))
                default:
                    break
            }
        }

        /// Fill-emit ops: `f`/`F`/`f*` paint, `B`/`b` (with their `*` even-odd and
        /// `b` implicit-close variants), and the `n`/`S`/`s` path discards.
        mutating func handleFillOp(_ op: String) {
            switch op {
                case "f", "F", "f*":
                    closeFill(op == "f*" ? "evenodd" : "nonzero")
                case "B", "B*", "b", "b*":
                    if op == "b" || op == "b*" { appendCommand(PathCommand(op: "Z", args: [])) }
                    closeFill(op.contains("*") ? "evenodd" : "nonzero")
                case "n", "S", "s":
                    path = []
                default:
                    break
            }
        }
    }

    /// `parseContentStream(buffer, alphaByName)` — interpret the CGContext-shaped
    /// operator subset into a flat list of fills.
    static func parse(_ buffer: [UInt8], alphaByName: [String: Double]) -> [Fill] {
        let tokens = tokenize(buffer)
        var interp = Interp()
        for token in tokens {
            switch token {
                case .number(let n):
                    interp.operands.append(.number(n))
                case .name(let value):
                    interp.operands.append(.name(value))
                case .op(let op):
                    interp.dispatch(op, alphaByName: alphaByName)
                    interp.operands.removeAll(keepingCapacity: true)
            }
        }
        return interp.fills
    }

    /// `tokenize(text)` — the JS content-stream tokenizer. Number tokens use JS
    /// `Number(slice)` (non-finite → an op token of the raw slice).
    private static func tokenize(_ bytes: [UInt8]) -> [Token] {
        var tokens: [Token] = []
        var i = 0
        let n = bytes.count
        while i < n {
            let ch = bytes[i]
            if ch == 0x25 {  // '%'
                if let nl = PdfScan.indexOf(bytes, "\n", from: i) {
                    i = nl + 1
                } else {
                    i = n
                }
                continue
            }
            if PdfScan.isPdfWhitespace(ch) {
                i += 1
                continue
            }
            if ch == 0x2F {  // '/'
                let start = i
                i += 1
                while i < n, !isTokenNameDelimiter(bytes[i]) { i += 1 }
                tokens.append(.name(PdfScan.asciiString(bytes, start, i)))
                continue
            }
            if ch == 0x2D || ch == 0x2E || PdfScan.isDigit(ch) {  // '-' '.' or digit
                let start = i
                i += 1
                while i < n, isNumberByte(bytes[i]) { i += 1 }
                let slice = PdfScan.asciiString(bytes, start, i)
                if let value = Double(slice), value.isFinite {
                    tokens.append(.number(value))
                } else {
                    tokens.append(.op(slice))
                }
                continue
            }
            if isAlpha(ch) || ch == 0x2A || ch == 0x27 || ch == 0x22 {  // A-Za-z * ' "
                let start = i
                i += 1
                while i < n, isOpByte(bytes[i]) { i += 1 }
                tokens.append(.op(PdfScan.asciiString(bytes, start, i)))
                continue
            }
            i += 1
        }
        return tokens
    }
}

// MARK: - Content-stream byte classes

/// `[A-Za-z]`.
private func isAlpha(_ b: UInt8) -> Bool { (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) }

/// Name delimiter in the content tokenizer: `/[\s/[\](){}<>]/` — note this set
/// adds `(`, `)`, `{`, `}` over the dictionary parser's class.
private func isTokenNameDelimiter(_ b: UInt8) -> Bool {
    if PdfScan.isPdfWhitespace(b) { return true }
    switch b {
        case 0x2F, 0x5B, 0x5D, 0x28, 0x29, 0x7B, 0x7D, 0x3C, 0x3E: return true  // / [ ] ( ) { } < >
        default: return false
    }
}

/// Number-continuation class `/[0-9.\-+eE]/`.
private func isNumberByte(_ b: UInt8) -> Bool {
    PdfScan.isDigit(b) || b == 0x2E || b == 0x2D || b == 0x2B || b == 0x65 || b == 0x45  // . - + e E
}

/// Operator-continuation class `/[A-Za-z0-9*'"]/`.
private func isOpByte(_ b: UInt8) -> Bool {
    isAlpha(b) || PdfScan.isDigit(b) || b == 0x2A || b == 0x27 || b == 0x22  // * ' "
}
