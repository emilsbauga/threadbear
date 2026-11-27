import Foundation
import Testing
@testable import ThreadbearKit

@Suite struct CoordinatorInboxTests {
    @Test func coordinatorsStayPutAndTheirQuestionsCount() {
        let now = Date.now
        let asleep = PhoneThread(threadId: "a", title: "A", lastActivityAt: now, snoozedUntil: now.addingTimeInterval(3600), waitState: "hibernating", coordinatorProjectId: "p_a")
        let asking = PhoneThread(threadId: "b", title: "Beta coordinator", needsYou: true, lastActivityAt: now, starredAt: now, waitState: "card", coordinatorProjectId: "p_b")
        let archived = PhoneThread(threadId: "c", title: "C", lastActivityAt: now, archivedAt: now, coordinatorProjectId: "p_c")
        let sections = InboxSections.build([asking, archived, asleep], now: now)
        #expect(sections.coordinators.map(\.threadId) == ["a", "b"])
        #expect(sections.starred.isEmpty && sections.inbox.isEmpty && sections.running.isEmpty)
        #expect(sections.needsYouCount == 1)
        #expect(!sections.isEmpty && !sections.isInboxZero)
        #expect(ThreadSearch("Beta coordinator", sections: sections, hibernating: [], archived: []).coordinators.map(\.threadId) == ["b"])
        #expect(InboxSections.hibernating(scheduled: [], snoozed: [asleep], wakes: [:]).isEmpty)
        #expect(PhoneSection.allCases.first == .coordinators)
    }

    @Test func malformedMetadataDoesNotDropTheThread() throws {
        let base = #"{"threadId":"t","runnerId":"mac","title":"t","cwd":"~","accountId":"a","provider":"claude","status":"idle","needsYou":false,"unread":false,"preview":"","lastActivityAt":0"#
        for value in ["null", "12", "{}", #""""#, #""  ""#] {
            let row = try JSONDecoder().decode(PhoneThread.self, from: Data((base + ",\"coordinatorProjectId\":" + value + "}").utf8))
            #expect(row.coordinatorProjectId == nil)
            #expect(InboxSections.build([row], now: .now).inbox.map(\.threadId) == ["t"])
        }
        let old = try JSONDecoder().decode(PhoneThread.self, from: Data((base + "}").utf8))
        #expect(old.coordinatorProjectId == nil)
    }
}
