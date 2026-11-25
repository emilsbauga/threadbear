import Foundation
import Testing
@testable import QuickAskCore

/// Quick ask's log (the system log and Library/Caches/quickask-events.log) is events, counts,
/// timings and error categories: what was said or spoken, thread ids, tokens and errors' own words
/// never go in (Daybreak finding 184, 24 Nov 2026: every line was public and the file kept
/// follow-ups and every spoken sentence word for word).
struct QuickAskLogTests {
    static let secret = "canary-7f3a quarterly salary figures"

    @Test func aPlainInterpolationIsPrivate() {
        let message: QuickAskLogMessage = "Sending a follow-up to \(Self.secret): \(Self.secret, privacy: .private)"
        #expect(!message.text.contains("canary"))
        #expect(message.text == "Sending a follow-up to <private>: <private>")
    }

    @Test func numbersBoolsAndPublicValuesStay() {
        let message: QuickAskLogMessage = "Queued sentence \(3) (\(Self.secret.count) characters), early: \(true), \("SFSpeechRecognizer", privacy: .public)"
        #expect(message.text == "Queued sentence 3 (36 characters), early: true, SFSpeechRecognizer")
    }

    @Test func errorsGoInOnlyAsTheirCategory() {
        let failures: [any Error] = [
            AskFailure.server(status: 500, message: Self.secret),
            AskFailure.badRequest(Self.secret),
            AskFailure.network(Self.secret),
            URLError(.timedOut, userInfo: [NSLocalizedDescriptionKey: Self.secret, NSURLErrorFailingURLStringErrorKey: "https://x/?token=\(Self.secret)"]),
            NSError(domain: "kAFAssistantErrorDomain", code: 1110, userInfo: [NSLocalizedDescriptionKey: Self.secret]),
        ]
        let lines = failures.map { error -> String in
            let message: QuickAskLogMessage = "Ask failed: \(error: error)"
            return message.text
        }
        #expect(lines == [
            "Ask failed: server 500",
            "Ask failed: badRequest",
            "Ask failed: network",
            "Ask failed: \(NSURLErrorDomain) -1001",
            "Ask failed: kAFAssistantErrorDomain 1110",
        ])
    }

    @Test func theFileGetsOnlyRedactedLinesAndTheOldLogGoes() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("quickask-log-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let old = dir.appendingPathComponent("quickask.log")
        try Data("quickask Sending a follow-up to t-1: \(Self.secret)\n".utf8).write(to: old)

        let store = QuickAskLogStore(directory: dir)
        store.removeOldLog()
        #expect(!FileManager.default.fileExists(atPath: old.path))

        let lines: [QuickAskLogMessage] = [
            "Sending a follow-up (\(Self.secret.count) characters) to \(Self.secret)",
            "Queued sentence 1: \(Self.secret)",
            "Ask failed: \(error: AskFailure.server(status: 502, message: Self.secret))",
        ]
        for line in lines { store.append(category: "quickask", error: false, line, at: Date()) }
        store.append(category: "quickask-net", error: true, "Ask failed: \(error: URLError(.timedOut))", at: Date())
        let written = try String(contentsOf: store.url, encoding: .utf8)
        #expect(!written.contains("canary"))
        #expect(written.contains("quickask Sending a follow-up (36 characters) to <private>"))
        #expect(written.contains("server 502"))
        #expect(written.contains("quickask-net ERROR Ask failed: \(NSURLErrorDomain) -1001"))
    }

    /// Every value a quick ask log call marks public is one of these: names, locale ids and
    /// strings the app builds from numbers. Adding one means checking it can't hold anything
    /// said, spoken or typed, a thread id, a token or an error's description.
    static let allowedPublic: Set<String> = [
        "message.text",  // QuickAskLogger: the already-redacted line
        "chosen?.name ?? \"system\"",
        "chosen?.language ?? \"\"",
        "word",
        "when",
        "how",
        "waited",
        "early ? \" (early)\" : \"\"",
        "wasActive ? \"already active\" : \"\\(ms(configured, activated)) ms\"",
        "sinceStart",
        "self.locale.identifier",
        "supported.identifier",
        "String(describing: self.readiness)",
        "locale.identifier",
        "error.domain",
        "trigger.rawValue",
        "transcriber.name",
        "failed.name",
    ]

    @Test func everyPublicValueIsOnTheList() throws {
        let ios = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        // However it's spelled: `privacy:.public`, `privacy: QuickAskLogPrivacy.public`, over lines.
        let marker = try Regex(#",\s*privacy\s*:\s*(?:QuickAskLogPrivacy\s*)?\.public\s*\)"#)
        var unlisted: [String] = []
        var seen = 0
        for folder in ["Threadbear/QuickAsk", "Threadbear/QuickAskCore"] {
            let dir = ios.appendingPathComponent(folder)
            for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) where name.hasSuffix(".swift") {
                let text = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
                // A message is only ever a literal: never built by hand from a string.
                if name != "QuickAskLogLine.swift", text.contains("QuickAskLogMessage(") || text.contains("stringLiteral:") {
                    unlisted.append("\(name): a QuickAskLogMessage built by hand")
                }
                for hit in text.matches(of: marker) {
                    seen += 1
                    let expression = Self.expression(before: hit.range.lowerBound, in: text)
                    if !Self.allowedPublic.contains(expression) { unlisted.append("\(name): \(expression)") }
                }
            }
        }
        #expect(seen > 10, "should find the call sites")
        #expect(unlisted.isEmpty, "Log only events, counts, timings and error categories (\\(error: e)): \(unlisted)")
    }

    @Test func theScanFindsEverySpelling() throws {
        let marker = try Regex(#",\s*privacy\s*:\s*(?:QuickAskLogPrivacy\s*)?\.public\s*\)"#)
        let text = #"""
        Log.app.info("a \(text,privacy:.public) b \(threadId, privacy: QuickAskLogPrivacy.public) c \(token,
            privacy: .public)")
        """#
        let found = text.matches(of: marker).map { Self.expression(before: $0.range.lowerBound, in: text) }
        #expect(found == ["text", "threadId", "token"])
    }

    /// The expression before a `, privacy: .public)`, back to its own `\(`.
    static func expression(before end: String.Index, in text: String) -> String {
        var depth = 0
        var index = end
        while index > text.startIndex {
            index = text.index(before: index)
            let char = text[index]
            if char == ")" { depth += 1 }
            if char == "(" {
                if depth == 0, index > text.startIndex, text[text.index(before: index)] == "\\" {
                    return String(text[text.index(after: index)..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
                }
                depth -= 1
            }
        }
        return String(text[..<end])
    }
}
