import AppKit
import Foundation
let output = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
for size in [16, 32, 48, 128, 256, 512, 1024] {
    let pixels = CGFloat(size)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSColor(calibratedRed: 0.22, green: 0.36, blue: 0.28, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: pixels * 0.04, y: pixels * 0.04, width: pixels * 0.92, height: pixels * 0.92), xRadius: pixels * 0.21, yRadius: pixels * 0.21).fill()
    let page = NSRect(x: pixels * 0.29, y: pixels * 0.2, width: pixels * 0.43, height: pixels * 0.6)
    NSColor.white.setStroke()
    let border = NSBezierPath(roundedRect: page, xRadius: pixels * 0.04, yRadius: pixels * 0.04)
    border.lineWidth = max(1, pixels * 0.055); border.stroke()
    let line = NSBezierPath(); line.lineWidth = max(1, pixels * 0.045)
    for y in [0.38, 0.53, 0.66] { line.move(to: NSPoint(x: pixels * 0.4, y: pixels * y)); line.line(to: NSPoint(x: pixels * 0.61, y: pixels * y)) }; line.stroke()
    NSGraphicsContext.restoreGraphicsState()
    let data = rep.representation(using: .png, properties: [:])!
    try data.write(to: URL(fileURLWithPath: "\(output)/icon\(size).png"))
}
