// The words in a picture, for the parity run's iPhone check
// (ios-shots.sh): macOS's own text recognition (Vision), so it reads what
// the simulator really drew, as the website's and the Mac's checks read
// their pages. Prints the picture's lines top to bottom.
//
//   swiftc -O scripts/parity/ocr.swift -o <bin>; <bin> <picture.png>
import Foundation
import Vision

guard CommandLine.arguments.count == 2, let image = NSURL(fileURLWithPath: CommandLine.arguments[1]) as URL? else {
    FileHandle.standardError.write("usage: ocr <picture.png>\n".data(using: .utf8)!)
    exit(2)
}
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
do {
    try VNImageRequestHandler(url: image).perform([request])
} catch {
    FileHandle.standardError.write("ocr: \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
// Vision's origin is the bottom left: top to bottom is y high to low.
let lines = (request.results ?? [])
    .sorted { abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.005 ? $0.boundingBox.midY > $1.boundingBox.midY : $0.boundingBox.minX < $1.boundingBox.minX }
    .compactMap { $0.topCandidates(1).first?.string }
print(lines.joined(separator: "\n"))
