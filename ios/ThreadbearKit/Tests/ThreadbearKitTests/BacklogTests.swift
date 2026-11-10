import Foundation
import Testing
import ThreadbearKit

@Suite struct BacklogTests {
    @Test func deferredConversationsUseBacklogWithoutAnUnsentPrompt() throws {
        var thread = PhoneThread(threadId: "existing", title: "Later", lastActivityAt: Date(), starredAt: Date())
        thread.backlogged = true
        let copy = try JSONDecoder().decode(PhoneThread.self, from: JSONEncoder().encode(thread))
        #expect(copy.backlogged == true)
        #expect(copy.backlog == nil)
        let sections = InboxSections.build([copy], now: Date())
        #expect(sections.backlog.map(\.threadId) == ["existing"])
        #expect(sections.starred.isEmpty)
        #expect(sections.needsYouCount == 0)
    }

    @Test func savedPromptsUseTheirOwnSection() throws {
        var thread = PhoneThread(threadId: "draft", title: "Later", lastActivityAt: Date(), starredAt: Date())
        thread.backlog = try JSONDecoder().decode(BacklogPrompt.self, from: Data(#"{"text":"A saved prompt","revision":1,"imageCount":2}"#.utf8))
        let sections = InboxSections.build([thread], now: Date())
        #expect(sections.backlog.map(\.threadId) == ["draft"])
        #expect(sections.inbox.isEmpty)
        #expect(sections.starred.isEmpty)
        #expect(sections.needsYouCount == 0)
        #expect(!sections.isEmpty)
        #expect(ThreadSearch("Later", sections: sections, hibernating: [], archived: []).backlog.count == 1)
        let copy = try JSONDecoder().decode(PhoneThread.self, from: JSONEncoder().encode(thread))
        #expect(copy.backlog?.text == "A saved prompt")
        #expect(copy.backlog?.imageCount == 2)
    }
}
