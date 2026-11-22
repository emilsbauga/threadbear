import Foundation
import Testing
@testable import ThreadbearKit

/// Reply buttons (docs/protocol/events.md, "Reply buttons"): a daily brief's
/// `[Fill in the form](button:<id>)` drawn as a button that starts a thread.
@Suite struct ReplyButtonsTests {
    let start = MessageButton(id: "abcd1234", title: "Fill in the form", kind: .start, target: "pebble")

    @Test func aButtonLinkIsATarget() {
        #expect(ThreadLinks.target(of: URL(string: "button:abcd1234")!) == .button("abcd1234"))
        #expect(ThreadLinks.target(of: URL(string: "button:")!) == nil)
    }

    @Test func buttonsAtTheEndOfALineArePeeledOff() {
        let line = "The Pebble form is due Friday. [Fill in the form](button:abcd1234) · [Not now](button:efgh5678)"
        let (text, links) = ReplyButtons.trailing(in: line)
        #expect(text == "The Pebble form is due Friday.")
        #expect(links == [.init(id: "abcd1234", title: "Fill in the form"), .init(id: "efgh5678", title: "Not now")])
    }

    @Test func aButtonWithWordsAfterItStaysInTheText() {
        let line = "Press [Go](button:abcd1234) when you're ready."
        #expect(ReplyButtons.trailing(in: line).links.isEmpty)
        #expect(ReplyButtons.trailing(in: "No buttons here.").text == "No buttons here.")
    }

    @Test func aButtonTheRowDoesNotCarryIsItsTitle() {
        let text = "[Go](button:abcd1234) and [Old](button:zzzz0000) and [web](https://x.y)"
        #expect(ReplyButtons.unlinking(text, except: ["abcd1234"]) == "[Go](button:abcd1234) and Old and [web](https://x.y)")
        #expect(ReplyButtons.unlinking(text, except: []) == "Go and Old and [web](https://x.y)")
    }

    @Test func aPressShowsAsPressingThenPressed() {
        #expect(ReplyButtons.look(start, status: nil, asking: false) == .ready)
        #expect(ReplyButtons.look(start, status: nil, asking: true) == .pressing)
        #expect(ReplyButtons.look(start, status: CommandStatus(state: .taken), asking: false) == .pressing)
        #expect(ReplyButtons.look(start, status: CommandStatus(state: .done, threadId: "t2"), asking: false) == .pressed(threadId: "t2"))
    }

    @Test func theRowSayingPressedWinsAndAFailureCanBePressedAgain() {
        var pressed = start
        pressed.pressedThreadId = "t3"
        #expect(ReplyButtons.look(pressed, status: CommandStatus(state: .failed, note: "x"), asking: false) == .pressed(threadId: "t3"))
        #expect(ReplyButtons.look(start, status: CommandStatus(state: .failed, note: "Folder not found"), asking: false) == .failed("Folder not found"))
        var failed = start
        failed.failed = "gone"
        #expect(ReplyButtons.look(failed, status: nil, asking: false) == .failed("gone"))
    }

    @Test func aRowDecodesItsButtonsAndAnOldRowHasNone() throws {
        let json = #"{"seq":4.0,"role":"assistant","text":"x","buttons":[{"id":"abcd1234","title":"Go","kind":"send","target":"Meetup","pressedThreadId":"t9"}],"at":"2026-11-07T00:00:00.000Z"}"#
        let m = try JSONDecoder().decode(PhoneMessage.self, from: Data(json.utf8))
        #expect(m.buttons == [MessageButton(id: "abcd1234", title: "Go", kind: .send, target: "Meetup", pressedThreadId: "t9")])
        let old = try JSONDecoder().decode(PhoneMessage.self, from: Data(#"{"seq":4,"role":"assistant","text":"x","at":"2026-11-07T00:00:00.000Z"}"#.utf8))
        #expect(old.buttons == nil)
    }

    /// A shared case file's cases this app runs: those whose `differs` doesn't name the iPhone.
    private static func shared(_ path: String) throws -> [[String: Any]] {
        // ios/ThreadbearKit/Tests/ThreadbearKitTests/ -> the repo.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let file = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent(path))) as? [String: Any])
        let cases = try #require(file["cases"] as? [[String: Any]])
        return cases.filter { ($0["differs"] as? [String: Any])?["ios"] == nil }
    }

    /// How a button looks, against the cases the desktop app, Android and
    /// the website run too.
    @Test func looksMatchTheSharedCases() throws {
        let cases = try Self.shared("shared/cases/reply-buttons.json")
        #expect(cases.count > 5)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let input = try #require(c["input"] as? [String: Any])
            let row = try #require(input["button"] as? [String: Any])
            let press = try #require(input["press"] as? [String: Any])
            let expect = try #require(c["expect"] as? [String: Any])
            let button = MessageButton(id: "abcd1234", title: "Go", kind: row["kind"] as? String == "send" ? .send : .start, target: row["target"] as? String,
                                       pressedThreadId: row["pressedThreadId"] as? String, failed: row["failed"] as? String)
            let state = press["state"] as? String ?? "none"
            var status: CommandStatus?
            if state != "none", state != "sending" {
                status = CommandStatus(state: try #require(CommandState(rawValue: state), "\(name)"), note: press["note"] as? String, threadId: press["threadId"] as? String)
            }
            let want: ReplyButtons.Look = switch expect["look"] as? String ?? "" {
            case "pressed": .pressed(threadId: expect["threadId"] as? String)
            case "failed": .failed(expect["error"] as? String ?? "")
            case "pressing": .pressing
            default: .ready
            }
            #expect(ReplyButtons.look(button, status: status, asking: state == "sending") == want, "\(name)")
        }
    }

    /// Button links as text, against the cases the desktop app and Android run too.
    @Test func buttonLinksMatchTheSharedCases() throws {
        let cases = try Self.shared("shared/cases/reply-button-links.json")
        #expect(cases.count > 5)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let input = try #require(c["input"] as? [String: Any])
            let expect = try #require(c["expect"] as? [String: Any])
            let text = try #require(input["text"] as? String)
            if input["op"] as? String == "unlink" {
                let known = Set(input["known"] as? [String] ?? [])
                #expect(ReplyButtons.unlinking(text, except: known) == expect["text"] as? String, "\(name)")
            } else {
                let (rest, links) = ReplyButtons.trailing(in: text)
                let want = (expect["links"] as? [[String: String]] ?? []).map { ReplyButtons.Link(id: $0["id"] ?? "", title: $0["title"] ?? "") }
                #expect(rest == expect["text"] as? String, "\(name)")
                #expect(links == want, "\(name)")
            }
        }
    }
}
