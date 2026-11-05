// The silent on-device secret check (src/secret-check.ts, off unless runner.json
// says so): Apple's on-device model, and Apple's OCR first for a picture, say
// whether some tool output looks like it holds a credential. It's an experiment
// to count how often that would be: nothing it answers changes what uploads.
//
// One JSON object a line on stdin, one a line on stdout, until stdin closes:
//   {"id":1,"text":"..."}            {"id":1,"verdict":"clean","ms":420}
//   {"id":2,"image":"/path.png"}     {"id":2,"verdict":"secret","ms":510}
// Verdicts: secret, clean, empty (a picture with no words), error. `--probe`
// prints "available" and exits 0, or "unavailable: why" and exits 3.
//
// It never prints, logs or stores the text it's given or the model's answer
// beyond the verdict, and an error is only the kind of error.
import AppKit
import Foundation
import FoundationModels
import Vision

let instructions = "You check tool output from a coding agent before it is uploaded. Decide if the text contains a real credential value: an API key, token, password, private key, recovery code or seed phrase. Names of variables, hashes, IDs, placeholders and masked values are not credentials. Answer with exactly one word: SECRET or CLEAN."
// About what the model's context takes, with room for its instructions.
let maxChars = 6000

struct Job: Decodable {
    let id: Int
    let text: String?
    let image: String?
}

struct Answer: Encodable {
    let id: Int
    let verdict: String
    let ms: Int
}

func recognise(_ path: String) -> String? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // Words corrected by language rules are worse here: keys aren't words.
    request.usesLanguageCorrection = false
    guard (try? VNImageRequestHandler(cgImage: image).perform([request])) != nil else { return nil }
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

@available(macOS 26.0, *)
func ask(_ text: String) async -> String {
    do {
        let session = LanguageModelSession(instructions: instructions)
        let answer = try await session.respond(to: "Text:\n" + String(text.prefix(maxChars)), options: GenerationOptions(temperature: 0)).content
        let upper = answer.uppercased()
        return upper.contains("SECRET") ? "secret" : upper.contains("CLEAN") ? "clean" : "error"
    } catch {
        return "error"
    }
}

@available(macOS 26.0, *)
func check(_ job: Job) async -> String {
    if let text = job.text { return await ask(text) }
    guard let path = job.image, let words = recognise(path) else { return "error" }
    return words.trimmingCharacters(in: .whitespacesAndNewlines).count < 10 ? "empty" : await ask(words)
}

func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

guard #available(macOS 26.0, *) else {
    say("unavailable: this macOS has no on-device model")
    exit(3)
}

switch SystemLanguageModel.default.availability {
case .available:
    break
case .unavailable(let why):
    switch why {
    case .deviceNotEligible: say("unavailable: this Mac can't run Apple's on-device model")
    case .appleIntelligenceNotEnabled: say("unavailable: Apple Intelligence is off")
    case .modelNotReady: say("unavailable: Apple's on-device model isn't ready yet")
    @unknown default: say("unavailable: Apple's on-device model isn't available")
    }
    exit(3)
}

if CommandLine.arguments.contains("--probe") {
    say("available")
    exit(0)
}

let encoder = JSONEncoder()
while let line = readLine(strippingNewline: true) {
    guard let job = try? JSONDecoder().decode(Job.self, from: Data(line.utf8)) else { continue }
    let started = Date()
    let verdict = await check(job)
    let answer = Answer(id: job.id, verdict: verdict, ms: Int(Date().timeIntervalSince(started) * 1000))
    if let data = try? encoder.encode(answer), let out = String(data: data, encoding: .utf8) { say(out) }
}
