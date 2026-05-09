export const FONT_TEXT_SCRIPT = `
import CoreText
import Foundation
import CoreGraphics

let fontPath = CommandLine.arguments[1]
let text = CommandLine.arguments[2]
let pointSize = CGFloat(Double(CommandLine.arguments[3]) ?? 96)
let url = URL(fileURLWithPath: fontPath)
var error: Unmanaged<CFError>?
CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
      let descriptor = descriptors.first,
      let fontName = CTFontDescriptorCopyAttribute(descriptor, kCTFontNameAttribute) as? String
else {
  FileHandle.standardError.write(Data("unable to load font descriptors".utf8))
  exit(2)
}
let font = CTFontCreateWithName(fontName as CFString, pointSize, nil)
let attr = NSAttributedString(string: text, attributes: [kCTFontAttributeName as NSAttributedString.Key: font])
let line = CTLineCreateWithAttributedString(attr)
let runs = CTLineGetGlyphRuns(line) as! [CTRun]

struct Shape {
  let d: String
  let bounds: CGRect
}

var shapes: [Shape] = []
var overall = CGRect.null

func fmt(_ value: CGFloat) -> String {
  let raw = String(format: "%.3f", Double(value))
  var out = raw
  while out.contains(".") && out.hasSuffix("0") { out.removeLast() }
  if out.hasSuffix(".") { out.removeLast() }
  return out
}

func convert(_ p: CGPoint, bounds: CGRect) -> CGPoint {
  CGPoint(x: p.x - bounds.minX, y: bounds.maxY - p.y)
}

for run in runs {
  let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
  let count = CTRunGetGlyphCount(run)
  var glyphs = Array(repeating: CGGlyph(), count: count)
  var positions = Array(repeating: CGPoint.zero, count: count)
  CTRunGetGlyphs(run, CFRange(location: 0, length: count), &glyphs)
  CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
  for index in 0..<count {
    guard let path = CTFontCreatePathForGlyph(runFont, glyphs[index], nil) else { continue }
    let offset = positions[index]
    var transform = CGAffineTransform(translationX: offset.x, y: offset.y)
    let translated = path.copy(using: &transform) ?? path
    let bounds = translated.boundingBoxOfPath
    if bounds.isNull || bounds.isEmpty { continue }
    overall = overall.union(bounds)
    var d = ""
    translated.applyWithBlock { elementPointer in
      let element = elementPointer.pointee
      switch element.type {
      case .moveToPoint:
        let p = element.points[0]
        d += "M\\(fmt(p.x)) \\(fmt(p.y)) "
      case .addLineToPoint:
        let p = element.points[0]
        d += "L\\(fmt(p.x)) \\(fmt(p.y)) "
      case .addQuadCurveToPoint:
        let c = element.points[0]
        let p = element.points[1]
        d += "Q\\(fmt(c.x)) \\(fmt(c.y)) \\(fmt(p.x)) \\(fmt(p.y)) "
      case .addCurveToPoint:
        let c1 = element.points[0]
        let c2 = element.points[1]
        let p = element.points[2]
        d += "C\\(fmt(c1.x)) \\(fmt(c1.y)) \\(fmt(c2.x)) \\(fmt(c2.y)) \\(fmt(p.x)) \\(fmt(p.y)) "
      case .closeSubpath:
        d += "Z "
      @unknown default:
        break
      }
    }
    shapes.append(Shape(d: d, bounds: bounds))
  }
}

guard !overall.isNull, !shapes.isEmpty else {
  FileHandle.standardError.write(Data("no glyph outlines".utf8))
  exit(3)
}

let padding = max(4, pointSize * 0.08)
let width = ceil(overall.width + padding * 2)
let height = ceil(overall.height + padding * 2)
var output = "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?>\\n"
output += "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"\\(fmt(width))\\" height=\\"\\(fmt(height))\\" viewBox=\\"0 0 \\(fmt(width)) \\(fmt(height))\\">\\n"
output += "  <title>\\(text.xmlEscaped)</title>\\n"
output += "  <g fill=\\"black\\">\\n"
for shape in shapes {
  var normalized = ""
  let scanner = PathNormalizer(d: shape.d, bounds: overall, padding: padding, height: height)
  normalized = scanner.normalized()
  output += "    <path d=\\"\\(normalized)\\"/>\\n"
}
output += "  </g>\\n</svg>\\n"
FileHandle.standardOutput.write(Data(output.utf8))

final class PathNormalizer {
  let tokens: [String]
  let bounds: CGRect
  let padding: CGFloat
  let height: CGFloat
  init(d: String, bounds: CGRect, padding: CGFloat, height: CGFloat) {
    self.tokens = d.split(separator: " ").map(String.init)
    self.bounds = bounds
    self.padding = padding
    self.height = height
  }
  func normalized() -> String {
    var out: [String] = []
    var index = 0
    while index < tokens.count {
      let op = tokens[index]
      index += 1
      if op == "Z" {
        out.append("Z")
        continue
      }
      let command = String(op.prefix(1))
      let firstNumber = String(op.dropFirst())
      var nums: [CGFloat] = []
      if let n = Double(firstNumber) { nums.append(CGFloat(n)) }
      let needed: Int
      switch command {
      case "M", "L": needed = 2
      case "Q": needed = 4
      case "C": needed = 6
      default: needed = 0
      }
      while nums.count < needed && index < tokens.count {
        if let n = Double(tokens[index]) { nums.append(CGFloat(n)) }
        index += 1
      }
      var converted: [String] = []
      for i in stride(from: 0, to: nums.count, by: 2) {
        let x = nums[i] - bounds.minX + padding
        let y = height - (nums[i + 1] - bounds.minY + padding)
        converted.append(fmt(x))
        converted.append(fmt(y))
      }
      out.append("\\(command)\\(converted.joined(separator: " "))")
    }
    return out.joined(separator: " ")
  }
}

extension String {
  var xmlEscaped: String {
    self
      .replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&apos;")
  }
}
`
