import Foundation
import Testing
@testable import ThreadbearKit

/// A command sent to the runner and waited on (PendingCommand), and the one
/// watcher that drives it (PendingCommands). Before 21 Nov each control kept
/// its own flags, and a reply button or Stop watched the old client with no
/// deadline, so one could spin for ever.
struct PendingCommandTests {
    /// The transition table, against the cases Android and the website run too.
    @Test func movesMatchTheSharedCases() throws {
        let cases = try Self.shared("shared/cases/pending-commands.json")
        #expect(cases.count > 20)
        for c in cases {
            let name = c["name"] as? String ?? "?"
            let events = try #require(c["input"] as? [[String: Any]])
            let expect = try #require(c["expect"] as? [String: Any])
            var state = PendingCommand.idle
            for e in events {
                let at = Date(timeIntervalSince1970: ((e["at"] as? Double) ?? 0) / 1000)
                let event: PendingCommand.Event
                switch e["event"] as? String {
                case "tap": event = .tap(at: at)
                case "sent": event = .sent(id: try #require(e["id"] as? String), at: at)
                case "sendFailed": event = .sendFailed(reason: try #require(e["reason"] as? String))
                case "row":
                    let row: CommandStatus? = switch e["state"] as? String {
                    case "pending": CommandStatus(state: .pending)
                    case "taken": CommandStatus(state: .taken)
                    case "done": CommandStatus(state: .done, threadId: e["threadId"] as? String)
                    case "failed": CommandStatus(state: .failed, note: e["note"] as? String)
                    default: nil
                    }
                    event = .row(row, at: at)
                case "deadline": event = .deadline(at: at)
                case "reconnected": event = .reconnected(at: at)
                case "cancelled": event = .cancelled
                case "settle": event = .settle
                default: Issue.record("\(name): unknown event"); continue
                }
                state = state.step(event)
            }
            #expect(Self.describe(state) as NSDictionary == expect as NSDictionary, "\(name): \(state)")
        }
    }

    /// A state as the case file writes it.
    static func describe(_ s: PendingCommand) -> [String: Any] {
        var out: [String: Any] = ["locked": s.locked]
        switch s {
        case .idle: out["state"] = "idle"
        case .sending: out["state"] = "sending"
        case let .queued(id, _): out["state"] = "queued"; out["id"] = id
        case let .taken(id, _): out["state"] = "taken"; out["id"] = id
        case let .done(id, result):
            out["state"] = "done"; out["id"] = id
            if let t = result?.threadId { out["threadId"] = t }
        case let .failed(id, reason):
            out["state"] = "failed"
            if let id { out["id"] = id }
            if let reason { out["reason"] = reason }
        case let .timedOut(id, taken):
            out["state"] = "timedOut"; out["taken"] = taken
            if let id { out["id"] = id }
        }
        return out
    }

    @Test func aFailureSaysItsOwnWordsWhenTheRunnerSaidNoneAndACancelSaysNothing() {
        #expect(PendingCommand.failed(id: "c", reason: nil).failure("Couldn't star it.") == "Couldn't star it.")
        #expect(PendingCommand.failed(id: "c", reason: "gone").failure("x") == "gone")
        #expect(PendingCommand.failed(id: "c", reason: PendingCommand.cancelledReason).failure("x") == nil)
        #expect(PendingCommand.timedOut(id: "c", taken: false).failure("x") == nil)
        #expect(PendingCommand.timedOut(id: "c", taken: false).timedOutNote != nil)
        #expect(PendingCommand.failed(id: "c", reason: " ").failure("Couldn't.") == "Couldn't.")
        // A send that never reached the backend puts its change back: it may never have gone.
        #expect(PendingCommand.timedOut(id: "c", taken: false).holdsChange)
        #expect(!PendingCommand.timedOut(id: nil, taken: false).holdsChange)
    }

    @Test func aReplyButtonTimedOutCanBePressedAgainSayingWhy() {
        let button = MessageButton(id: "abcd1234", title: "Go", kind: .start)
        #expect(ReplyButtons.look(button, pending: .queued(id: "c", since: .now)) == .pressing)
        #expect(ReplyButtons.look(button, pending: .done(id: "c", result: CommandStatus(state: .done, threadId: "t2"))) == .pressed(threadId: "t2"))
        #expect(ReplyButtons.look(button, pending: .failed(id: "c", reason: nil)) == .failed("The runner couldn't press it."))
        guard case .failed = ReplyButtons.look(button, pending: .timedOut(id: "c", taken: false)) else { Issue.record("timed out should be pressable"); return }
        var pressed = button
        pressed.pressedThreadId = "t3"
        #expect(ReplyButtons.look(pressed, pending: .timedOut(id: "c", taken: false)) == .pressed(threadId: "t3"))
    }

    // MARK: The watcher, against the FakeBackend

    /// `eventually`, on the main actor, where the watcher lives.
    @MainActor private func until(timeout: Duration = .seconds(5), _ check: () -> Bool) async {
        let clock = ContinuousClock()
        let end = clock.now + timeout
        while clock.now < end {
            if check() { return }
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    @MainActor private func store(_ backend: FakeBackend, deadline: TimeInterval = 0.3) -> PendingCommands {
        let store = PendingCommands()
        store.deadline = deadline
        store.retryAfter = .milliseconds(50)
        store.use(backend)
        return store
    }

    @MainActor @Test func aChangeTheRunnerDoesIsDoneThenLetGo() async throws {
        let fake = FakeBackend(turnDelay: .zero)
        let commands = store(fake)
        var heard: [PendingCommand] = []
        let started = commands.start(.star("a1"), value: "on", settle: .milliseconds(100), send: { try await $0.update(threadId: "a1", change: .star(true)) },
                                     then: { heard.append($0) })
        #expect(started)
        #expect(commands[.star("a1")].locked)
        #expect(commands.value(.star("a1")) == "on")
        await until { if case .done = commands[.star("a1")] { true } else { false } }
        #expect(commands[.star("a1")].holdsChange)
        await until { commands[.star("a1")] == .idle }
        #expect(commands.entries.isEmpty)
        #expect(heard.count == 1)
    }

    @MainActor @Test func aCommandNeverTakenTimesOutStillListeningAndLandsLater() async throws {
        let fake = FakeBackend(turnDelay: .zero)
        fake.holdsCommands = true
        let commands = store(fake)
        var heard: [PendingCommand] = []
        commands.start(.press(threadId: "a1", buttonId: "b"), send: { try await $0.press(threadId: "a1", buttonId: "b") }, then: { heard.append($0) })
        await until { commands[.press(threadId: "a1", buttonId: "b")].isTimedOut }
        let state = commands[.press(threadId: "a1", buttonId: "b")]
        #expect(!state.locked)
        #expect(state.holdsChange)
        #expect(heard.count == 1)
        // The Mac wakes and does it: the late answer still lands.
        fake.setCommand(try #require(state.id), CommandStatus(state: .done, threadId: "t2"))
        await until { if case .done = commands[.press(threadId: "a1", buttonId: "b")] { true } else { false } }
        #expect(heard.count == 2)
    }

    @MainActor @Test func aRefusedCommandFailsWithWhy() async throws {
        let fake = FakeBackend(turnDelay: .zero)
        fake.changesFail = true
        let commands = store(fake, deadline: 5)
        commands.start(.wake("a1"), send: { try await $0.update(threadId: "a1", change: .wake) })
        await until { commands[.wake("a1")].isFailed }
        #expect(commands[.wake("a1")].failure("x") == "The Mac couldn't do that just now.")
        #expect(!commands[.wake("a1")].holdsChange)
        // It can be tapped again.
        fake.changesFail = false
        let again = commands.start(.wake("a1"), send: { try await $0.update(threadId: "a1", change: .wake) })
        #expect(again)
    }

    @MainActor @Test func aSendThatThrowsFails() async throws {
        let fake = FakeBackend(turnDelay: .zero)
        let commands = store(fake)
        commands.start(.stop("a1"), send: { _ in throw TransportError.server("expired") })
        await until { commands[.stop("a1")].isFailed }
        #expect(commands[.stop("a1")] == .failed(id: nil, reason: "expired"))
    }

    @MainActor @Test func aReconnectMidWaitListensOnTheNewClient() async throws {
        let old = FakeBackend(turnDelay: .zero)
        old.holdsCommands = true
        let commands = store(old, deadline: 30)
        commands.start(.archive("a1"), send: { try await $0.update(threadId: "a1", change: .archive) })
        await until { if case .queued = commands[.archive("a1")] { true } else { false } }
        let id = try #require(commands[.archive("a1")].id)
        // A fresh client (coming back from the background): the old one never answers again.
        let fresh = FakeBackend(turnDelay: .zero)
        fresh.setCommand(id, CommandStatus(state: .taken))
        commands.use(fresh)
        await until { if case .taken = commands[.archive("a1")] { true } else { false } }
        fresh.setCommand(id, CommandStatus(state: .done))
        await until { if case .done = commands[.archive("a1")] { true } else { false } }
    }

    @MainActor @Test func aDoubleTapSendsOnce() async throws {
        let fake = FakeBackend(turnDelay: .zero)
        fake.holdsCommands = true
        let commands = store(fake, deadline: 30)
        let send: @Sendable (any Backend) async throws -> String = { try await $0.update(threadId: "a1", change: .star(true)) }
        #expect(commands.start(.star("a1"), send: send))
        #expect(!commands.start(.star("a1"), send: send))
        await until { commands[.star("a1")].id != nil }
        #expect(!commands.start(.star("a1"), send: send))
        #expect(fake.updateCount == 1)
    }

    @MainActor @Test func unpairingLetsGoOfEverything() async throws {
        let fake = FakeBackend(turnDelay: .zero)
        fake.holdsCommands = true
        let commands = store(fake, deadline: 30)
        commands.start(.star("a1"), send: { try await $0.update(threadId: "a1", change: .star(true)) })
        commands.start(.stop("a2"), send: { try await $0.interrupt(threadId: "a2") })
        commands.use(nil)
        #expect(commands.entries.isEmpty)
        let unpaired = commands.start(.star("a1"), send: { try await $0.update(threadId: "a1", change: .star(true)) })
        #expect(!unpaired)
    }

    @MainActor @Test func aCancelFailsItQuietly() async throws {
        let fake = FakeBackend(turnDelay: .zero)
        fake.holdsCommands = true
        let commands = store(fake, deadline: 30)
        commands.start(.card("ap1"), value: "allow", send: { try await $0.update(threadId: "a1", change: .markSeen) })
        await until { commands[.card("ap1")].id != nil }
        commands.cancelled(.card("ap1"))
        #expect(commands[.card("ap1")].isFailed)
        #expect(commands[.card("ap1")].failure("x") == nil)
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
}
