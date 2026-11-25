import Foundation
import Testing
@testable import ThreadbearKit

/// The phone draws the runner's wait state (`waitState`) into the section,
/// the Needs you order and the badge, against the cases the runner and the
/// other apps run (shared/cases/wait-states.json).
@Suite struct WaitStatesTests {
    struct Cases: Decodable {
        struct Case: Decodable {
            struct Thread: Decodable {
                var status: String?
                var needsYou: Bool?
                var needs: String?
                var pendingReviews: Double?
                var snoozedUntil: Date?
                var snoozedUntilRestart: Bool?
                var archivedAt: Date?
                var starredAt: Date?
            }
            var name: String
            var thread: Thread
            var scheduled: Bool?
            var state: String
            var section: String
            var urgency: Int
            var counted: Bool
        }
        var now: Date
        var cases: [Case]
    }

    static func cases() throws -> Cases {
        // ios/ThreadbearKit/Tests/ThreadbearKitTests/ -> the repo.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("shared/cases/wait-states.json")
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(Cases.self, from: Data(contentsOf: url))
    }

    @Test func theSharedCases() throws {
        let file = try Self.cases()
        #expect(file.cases.count >= 30)
        let now = file.now
        for c in file.cases {
            let status = try #require(ThreadStatus(rawValue: c.thread.status ?? "idle"), "\(c.name)")
            let row = PhoneThread(threadId: "t", title: "t", status: status, needsYou: c.thread.needsYou ?? false,
                                  lastActivityAt: now, snoozedUntil: c.thread.snoozedUntil,
                                  snoozedUntilRestart: c.thread.snoozedUntilRestart, archivedAt: c.thread.archivedAt,
                                  starredAt: c.thread.starredAt, needs: c.thread.needs,
                                  pendingReviews: c.thread.pendingReviews, waitState: c.state)
            let section = InboxSections.section(row, now: now)
            #expect(section.rawValue == c.section, "\(c.name)")
            #expect(InboxSections.urgency(row) == c.urgency, "\(c.name)")

            // Where the inbox list puts it: Starred, Inbox and Running from
            // it, Hibernating from it only when not snoozed (a schedule's),
            // else from the snoozed list, and Archived from the den.
            let built = InboxSections.build([row], now: now)
            let lists: [(PhoneSection, [PhoneThread])] = [(.backlog, built.backlog), (.starred, built.starred), (.inbox, built.inbox),
                                                          (.running, built.running), (.hibernating, built.scheduled)]
            let found = lists.filter { !$0.1.isEmpty }.map(\.0)
            switch section {
            case .backlog, .starred, .inbox, .running: #expect(found == [section], "\(c.name)")
            case .hibernating:
                let snoozed = InboxSections.isSnoozed(row, now: now)
                #expect(found == (snoozed ? [] : [.hibernating]), "\(c.name)")
                let shown = InboxSections.hibernating(scheduled: built.scheduled, snoozed: snoozed ? [row] : [], wakes: [:])
                #expect(shown.map(\.threadId) == ["t"], "\(c.name)")
            case .archived: #expect(found.isEmpty, "\(c.name)")
            }
            #expect(built.needsYouCount == (c.counted ? 1 : 0), "\(c.name)")
        }
    }

    @Test func anUnknownStateIsDrawnAsDone() throws {
        let row = PhoneThread(threadId: "t", title: "t", lastActivityAt: .now, needs: "you", waitState: "somethingNew")
        #expect(row.wait == .done)
        #expect(InboxSections.section(row, now: .now) == .inbox)
        #expect(InboxSections.urgency(row) == 4)
        #expect(InboxSections.build([row], now: .now).needsYouCount == 0)
    }

    /// A new runner keeps a thread its agent put away to wait on other
    /// threads in the inbox list, snoozed: it's under Running, not dropped.
    @Test func putAwayOnItsOwnWorkIsRunning() {
        let now = Date.now
        let row = PhoneThread(threadId: "t", title: "t", lastActivityAt: now, snoozedUntil: now.addingTimeInterval(3600),
                              waitState: WaitState.onThreads.rawValue)
        #expect(InboxSections.build([row], now: now).running.map(\.threadId) == ["t"])
    }

    @Test func rowsDecodeWithAndWithoutIt() throws {
        let base = #"{"threadId":"t","runnerId":"mac","title":"t","cwd":"~","accountId":"a","provider":"claude","status":"idle","needsYou":false,"unread":false,"preview":"","lastActivityAt":0"#
        let old = try JSONDecoder().decode(PhoneThread.self, from: Data((base + "}").utf8))
        #expect(old.waitState == nil)
        let new = try JSONDecoder().decode(PhoneThread.self, from: Data((base + #","waitState":"review"}"#).utf8))
        #expect(new.wait == .review)
        #expect(RowStatus.kind(new) == .needsYou)
    }

    @Test func sendingIsRunning() {
        let row = PhoneThread(threadId: "t", title: "t", lastActivityAt: .now, waitState: WaitState.sending.rawValue)
        #expect(InboxSections.section(row, now: .now) == .running)
        #expect(RowStatus.kind(row) == .working)
    }
}
