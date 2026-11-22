import Foundation
import Testing
@testable import ThreadbearKit

/// ```slack, ```email and ```draft blocks: text for Mike to send elsewhere,
/// shown line for line with a Copy button. The Mac's DraftBlockTests
/// (app/Tests/ThreadbearCoreTests) and the website's draft.test.ts check the
/// same cases.
@Suite struct DraftBlockTests {
    @Test func onlyTheDraftFencesCount() {
        #expect(DraftBlock.from(language: "slack", code: "hi\n")?.kind == .slack)
        #expect(DraftBlock.from(language: "Email subject=x", code: "hi")?.kind == .email)
        #expect(DraftBlock.from(language: "draft", code: "hi")?.kind == .draft)
        #expect(DraftBlock.from(language: "slackbot", code: "hi") == nil)
        #expect(DraftBlock.from(language: nil, code: "hi") == nil)
        #expect(DraftBlock.from(language: "slack", code: " \n\n") == nil)
        #expect(DraftBlock.from(language: "slack", code: "a\r\nb\n\n")?.source == "a\nb")
        #expect(DraftBlock(kind: .slack, source: "x").label == "Slack draft")
        #expect(DraftBlock(kind: .email, source: "x").label == "Email draft")
        #expect(DraftBlock(kind: .draft, source: "x").label == "Draft")
    }

    @Test func everyLineStaysALine() {
        let draft = DraftBlock(kind: .draft, source: "*Threadbear, 6 Nov*\n• one\n• two\n\nThanks")
        #expect(draft.lines.map { $0.spans.map(\.text).joined() } == ["*Threadbear, 6 Nov*", "• one", "• two", "", "Thanks"])
        // Only a Slack draft reads Slack's formatting.
        #expect(!draft.lines[0].spans[0].bold)
        #expect(draft.plainText == draft.source)
    }

    @Test func slackFormatting() {
        let spans = DraftBlock.slackSpans("*Shipped* _today_: ~old~ `tb land` and *_both_*")
        #expect(spans == [
            .init("Shipped", bold: true), .init(" "), .init("today", italic: true), .init(": "),
            .init("old", strike: true), .init(" "), .init("tb land", code: true), .init(" and "),
            .init("both", bold: true, italic: true),
        ])
    }

    @Test(arguments: ["2*3*4", "snake_case_name", "a * b * c", "*open only", "price: $5_000_"])
    func markersInsideWordsAndLoneOnesStayAsWritten(text: String) {
        #expect(DraftBlock.slackSpans(text) == [.init(text)])
    }

    @Test func markdownBoldIsSlackBoldWithAStarEitherSide() {
        // Markdown's **bold** is Slack's *bold* with a star either side,
        // which is how Slack shows it too.
        #expect(DraftBlock.slackSpans("**x**") == [.init("*"), .init("x", bold: true), .init("*")])
    }

    @Test func linksAndMentions() {
        let spans = DraftBlock.slackSpans("See <https://example.com/a?b=1|the docs>, <https://x.dev> or <mailto:m@x.dev>; cc <@U123> in <#C9|general> <!here> & 1 < 2 &amp; <b>")
        let links = spans.compactMap(\.link).map(\.absoluteString)
        #expect(links == ["https://example.com/a?b=1", "https://x.dev", "mailto:m@x.dev"])
        #expect(spans.map(\.text).joined() == "See the docs, https://x.dev or m@x.dev; cc @U123 in #general @here & 1 < 2 & <b>")
        // Other schemes aren't links.
        #expect(DraftBlock.slackSpans("<javascript:alert(1)|x>").first?.link == nil)
        #expect(DraftBlock.slackSpans("<javascript:alert(1)|x>").map(\.text).joined() == "<javascript:alert(1)|x>")
    }

    @Test func copyKeepsSlacksMarkersButSpellsOutLinks() {
        let draft = DraftBlock(kind: .slack, source: "*Done* <https://x.dev/pr/1|the PR>\n<https://x.dev>\n> quoted &lt;tag&gt;")
        #expect(draft.plainText == "*Done* the PR (https://x.dev/pr/1)\nhttps://x.dev\n> quoted <tag>")
        #expect(draft.html == "<meta charset=\"utf-8\"><div><b>Done</b> <a href=\"https://x.dev/pr/1\">the PR</a><br><a href=\"https://x.dev\">https://x.dev</a><blockquote>quoted &lt;tag&gt;</blockquote></div>")
        #expect(draft.lines[2].quote)
    }

    @Test func htmlIsEscaped() {
        let draft = DraftBlock(kind: .email, source: "Hi <script>alert(\"x\")</script> & bye")
        #expect(draft.html == "<meta charset=\"utf-8\"><div>Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; bye</div>")
    }

    // Cross-lab review, 6 Nov.
    @Test func tokensInsideCodeStayAsWrittenAndALinkCanBeBold() {
        #expect(DraftBlock.slackSpans("`<@U123>` and `a < b`") == [.init("<@U123>", code: true), .init(" and "), .init("a < b", code: true)])
        let url = URL(string: "https://x.dev")!
        #expect(DraftBlock.slackSpans("*See <https://x.dev|docs>*") == [.init("See ", bold: true), .init("docs", bold: true, link: url)])
        #expect(DraftBlock.slackSpans("<https://x.dev|a>_b_") == [.init("a", link: url), .init("b", italic: true)])
        // Copied as plain text, code keeps its tokens as typed too.
        #expect(DraftBlock(kind: .slack, source: "`<@U1>` <@U1> `<https://x.dev|docs>` <https://x.dev|docs>").plainText
            == "`<@U1>` @U1 `<https://x.dev|docs>` docs (https://x.dev)")
    }

    @Test func hostileLinesStayQuick() {
        let start = Date()
        _ = DraftBlock.slackSpans(String(repeating: "<", count: DraftBlock.maxFormattedLine))
        _ = DraftBlock.slackSpans(String(repeating: " *a", count: DraftBlock.maxFormattedLine / 3))
        _ = DraftBlock(kind: .slack, source: String(repeating: "<", count: DraftBlock.maxSource)).plainText
        _ = DraftBlock(kind: .slack, source: String(repeating: "<", count: DraftBlock.maxSource - 1) + ">").plainText
        #expect(Date().timeIntervalSince(start) < 2)
        // A line past the limit is shown as written; a draft past its limit stays code.
        let long = "*" + String(repeating: "a", count: DraftBlock.maxFormattedLine) + "*"
        #expect(DraftBlock.slackSpans(long) == [.init(long)])
        #expect(DraftBlock.from(language: "slack", code: String(repeating: "a", count: DraftBlock.maxSource + 1)) == nil)
        // A placeholder character in the text itself turns formatting off for the line.
        #expect(DraftBlock.slackSpans("*a* \u{E000}") == [.init("*a* \u{E000}")])
    }

    @Test func copiedHTMLKeepsIndentsAndLinedUpSpaces() {
        let draft = DraftBlock(kind: .email, source: "    • nested\nA    B")
        #expect(draft.html == "<meta charset=\"utf-8\"><div>&nbsp;&nbsp;&nbsp;&nbsp;• nested<br>A &nbsp;&nbsp;&nbsp;B</div>")
    }

    /// The cases every app runs (shared/cases/draft-blocks.json): the desktop
    /// app, Android, the website and here. A case whose `differs` names ios
    /// is a known difference, skipped. `closed` is answered by parsing the
    /// text as the phone draws it, a draft anywhere in it, quotes included.
    @Test func theSharedCases() throws {
        struct Case: Decodable {
            var name: String
            var input: [String: JSONValue]
            var expect: JSONValue
            var differs: [String: String]?
        }
        struct File: Decodable { var cases: [Case] }
        func neutral(_ spans: [DraftBlock.Span]) -> JSONValue {
            .array(spans.map { s in
                var o: [String: JSONValue] = ["text": .string(s.text)]
                if s.bold { o["bold"] = .bool(true) }
                if s.italic { o["italic"] = .bool(true) }
                if s.strike { o["strike"] = .bool(true) }
                if s.code { o["code"] = .bool(true) }
                if let link = s.link { o["link"] = .string(link.absoluteString) }
                return .object(o)
            })
        }
        func hasDraft(_ blocks: [MarkdownBlock]) -> Bool {
            blocks.contains { block in
                switch block {
                case .draft: return true
                case let .quote(inner): return hasDraft(inner)
                default: return false
                }
            }
        }
        // ios/ThreadbearKit/Tests/ThreadbearKitTests/ -> the repo.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("shared/cases/draft-blocks.json")
        let cases = try JSONDecoder().decode(File.self, from: Data(contentsOf: url)).cases
        #expect(cases.count >= 50)
        for c in cases where c.differs?["ios"] == nil {
            func text(_ key: String) -> String {
                if case let .string(s) = c.input[key] { return s }
                return ""
            }
            func draft() throws -> DraftBlock {
                DraftBlock(kind: try #require(DraftBlock.Kind(rawValue: text("kind")), "\(c.name)"), source: text("source"))
            }
            let got: JSONValue
            switch text("op") {
            case "from":
                var language: String?
                if case let .string(s) = c.input["language"] { language = s }
                if let d = DraftBlock.from(language: language, code: text("code")) {
                    got = .object(["kind": .string(d.kind.rawValue), "source": .string(d.source), "label": .string(d.label)])
                } else {
                    got = .null
                }
            case "lines":
                got = .array(try draft().lines.map { .object(["quote": .bool($0.quote), "spans": neutral($0.spans)]) })
            case "plainText": got = .string(try draft().plainText)
            case "html": got = .string(try draft().html)
            case "spans": got = neutral(DraftBlock.slackSpans(text("line")))
            case "closed": got = .bool(hasDraft(MarkdownBlock.parse(text("text"))))
            default:
                Issue.record("\(c.name): no \(text("op")) on the phone")
                continue
            }
            #expect(got == c.expect, "\(c.name)")
        }
    }

    @Test func aSentMessageGivesBackItsEditedDrafts() {
        let intro = "I edited your draft. Use my version below exactly as it is, not yours:"
        let one = "Send it\n\n\(intro)\n\n```email\nHi Geoff,\n\nCheers\n```"
        let split = DraftBlock.splitEdited(one)
        #expect(split?.words == "Send it")
        #expect(split?.drafts == [DraftBlock(kind: .email, source: "Hi Geoff,\n\nCheers")])
        #expect(DraftBlock.splitEdited("\(intro)\n\n```slack\nhey\n```")?.words == "")
        let many = "I edited your drafts. Use my versions below exactly as they are, not yours:"
        let two = "ok\n\n\(many)\n\n```draft\nrun `x`\n```\n\n````email\na\n```\nb\n```\n\nc\n````"
        #expect(DraftBlock.splitEdited(two)?.drafts.map(\.source) == ["run `x`", "a\n```\nb\n```\n\nc"])
        #expect(DraftBlock.splitEdited("Send it") == nil)
        #expect(DraftBlock.splitEdited("\(one)\n\nand another thing") == nil)
        #expect(DraftBlock.splitEdited("He said \(intro)\n\n```email\nx\n```") == nil)
        #expect(DraftBlock.splitEdited("\(intro)\n\n```python\nx\n```") == nil)
        // A draft that quotes the line itself still comes apart at the real one.
        #expect(DraftBlock.splitEdited("ok\n\n\(intro)\n\n```email\nThe app said:\n\n\(intro)\n```")?.words == "ok")
        // A long one is shown too, and Windows line ends are plain ones.
        let long = String(repeating: "x", count: DraftBlock.maxSource + 1)
        #expect(DraftBlock.splitEdited("\(intro)\n\n```draft\n\(long)\n```")?.drafts.first?.source == long)
        #expect(DraftBlock.splitEdited("\(intro)\n\n```email\na\r\nb\n```")?.drafts.first?.source == "a\nb")
    }
}
