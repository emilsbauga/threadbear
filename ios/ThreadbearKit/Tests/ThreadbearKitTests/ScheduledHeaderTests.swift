import Foundation
import Testing
@testable import ThreadbearKit

/// A schedule's message on the phone: its header line becomes the card's
/// label, as the Mac's ScheduleTests and row_text_tests check.
@Suite struct ScheduledHeaderTests {
    @Test func readsTheHeaderLine() throws {
        let header = try #require(ScheduledHeader("[Scheduled: \"Check \"prod\", again\", Once, Tue 28 Oct at 15:30]\nIs it up?\nSay so."))
        #expect(header.title == "Check \"prod\", again")
        #expect(header.whenText == "Once, Tue 28 Oct at 15:30")
        #expect(header.body == "Is it up?\nSay so.")
        #expect(ScheduledHeader("Just a message") == nil)
        #expect(ScheduledHeader("[Scheduled: no quotes]") == nil)
        #expect(ScheduledHeader("[Scheduled: \"T\", Every hour]")?.body == "")
        // The runner puts a blank line after it.
        #expect(ScheduledHeader("[Scheduled: \"T\", Every hour]\n\nGo.\n```\nx\n```")?.body == "Go.\n```\nx\n```")
    }

    @Test func onlyAScheduleGetsTheCard() {
        let text = "[Scheduled: \"T\", Every 5 minutes]\n\nGo."
        let sent = PhoneMessage(seq: 1, role: .user, text: text, origin: "schedule", at: .now)
        #expect(sent.scheduledCard?.label == "T · Every 5 minutes")
        #expect(sent.scheduledCard?.body == "Go.")
        // Mike typing the header is still Mike.
        #expect(PhoneMessage(seq: 1, role: .user, text: text, origin: "phone", at: .now).scheduledCard == nil)
        #expect(PhoneMessage(seq: 1, role: .user, text: "Go.", origin: "schedule", at: .now).scheduledCard?.label == "Sent by a schedule")
    }
}
