import Foundation
import Testing
import ThreadbearKit

/// The phone's copy of the Mac's LinkPolicy, which LinkGate decides with:
/// a reply's link to another app waits for a yes, a web page opens
/// (Daybreak, 7 Nov). The Mac's LinkPolicyTests checks the two files match.
@Suite struct LinkPolicyTests {
    @Test func onlyWebPagesOpenWithoutAsking() throws {
        for web in ["https://example.com/", "HTTP://localhost:5173/"] {
            guard case .web = LinkPolicy.kind(of: try #require(URL(string: web))) else { Issue.record("\(web) is web"); continue }
        }
        for other in ["shortcuts://run-shortcut?name=x", "tel:123", "JaVaScRiPt:alert(1)", "itms-services://?action=download-manifest",
                      "prefs:root=General", "threadbear://pair?url=x"] {
            guard case .ask = LinkPolicy.kind(of: try #require(URL(string: other))) else { Issue.record("\(other) asks"); continue }
        }
        guard case .file = LinkPolicy.kind(of: try #require(URL(string: "file:///etc/hosts"))) else { Issue.record("a file is the Mac's"); return }
    }

    struct Cases: Decodable {
        struct Case: Decodable {
            var name: String
            var input: String
            var expect: String
            var differs: [String: String]?
        }
        var cases: [Case]
    }

    /// The cases the desktop app, Android and the website run too
    /// (shared/cases/link-policy.json), through LinkCheck as LinkGate
    /// decides. A string URL can't read is refused.
    @Test func theSharedCases() throws {
        // ios/ThreadbearKit/Tests/ThreadbearKitTests/ -> the repo.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("shared/cases/link-policy.json")
        let cases = try JSONDecoder().decode(Cases.self, from: Data(contentsOf: url)).cases
        #expect(cases.count >= 40)
        for c in cases where c.differs?["ios"] == nil {
            let kind: String
            switch URL(string: c.input).map(LinkCheck.kind(of:)) {
            case .web: kind = "web"
            case .ask: kind = "ask"
            case .file: kind = "file"
            case .refuse, nil: kind = "refuse"
            }
            #expect(kind == c.expect, "\(c.name)")
        }
    }

    // Daybreak 167 (22 Nov 2026): the question showed the first 200 and last
    // 100 characters of a link that asks, and opened all of it.

    @Test func theQuestionShowsTheWholeLinkItOpens() throws {
        let long = "x-app://do?" + String(repeating: "a=1&", count: 200) + "send=everything"
        let url = try #require(URL(string: long))
        guard case .ask(let opened) = LinkCheck.kind(of: url) else { Issue.record("it asks"); return }
        #expect(opened == url, "what opens is the URL asked about")
        let question = LinkCheck.question(opened)
        #expect(question.title == "Open this x-app link?")
        #expect(question.detail.hasSuffix("\n\n" + opened.absoluteString), "the whole link, as it opens")
        #expect(opened.absoluteString == long)
    }

    @Test func oneLengthLimitBeforeTheScheme() throws {
        let ask = "x-app://" + String(repeating: "a", count: LinkCheck.maxAskLink - 8)
        guard case .ask = LinkCheck.kind(of: try #require(URL(string: ask))) else { Issue.record("at the limit it asks"); return }
        #expect(LinkCheck.kind(of: try #require(URL(string: ask + "a"))) == .refuse, "too long to show whole")
        #expect(LinkCheck.kind(of: try #require(URL(string: "mailto:" + String(repeating: "a", count: 10_000)))) == .refuse)
        let web = "https://x.dev/" + String(repeating: "a", count: LinkCheck.maxLink - 14)
        guard case .web = LinkCheck.kind(of: try #require(URL(string: web))) else { Issue.record("a long web page opens"); return }
        #expect(LinkCheck.kind(of: try #require(URL(string: web + "a"))) == .refuse)
        guard case .ask = LinkCheck.kind(of: try #require(URL(string: "mailto:mike@example.com?subject=Hi%20there&body=Line%0Atwo"))) else {
            Issue.record("an ordinary mailto still asks"); return
        }
    }

    /// A URL made from a string with a raw control or bidi character in it
    /// either can't be made, or has it percent-encoded, which the question
    /// shows as it is. Either way nothing that hides text reaches it.
    @Test func charactersThatHideTextNeverReachTheQuestion() throws {
        for c in ["\r", "\n", "\t", "\u{7F}", "\u{85}", "\u{202E}", "\u{2066}", "\u{200F}", "\u{200B}", "\u{FEFF}", "\u{AD}", "\u{2028}", "\u{E0001}"] {
            #expect(LinkCheck.hidesText("x-app://do?to=me\(c)&to=you"))
            for raw in ["x-app://do?to=me\(c)&to=you", "https://example.com/\(c)x"] {
                guard let url = URL(string: raw) else { continue }
                switch LinkCheck.kind(of: url) {
                case .refuse: break
                case .ask(let u), .web(let u), .file(let u):
                    #expect(!LinkCheck.hidesText(u.absoluteString), "\(raw.unicodeScalars.map { String($0.value, radix: 16) })")
                }
            }
        }
        #expect(!LinkCheck.hidesText("x-app://café/日本"), "letters from any language are fine")
    }
}
