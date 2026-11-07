import XCTest
@testable import ThreadbearCore

final class BacklogTests: XCTestCase {
    func testBacklogIsItsOwnSectionAndDoesNotCountAsInboxWork() throws {
        var draft = ThreadSummary(id: "draft", title: "Plan the homepage")
        draft.backlog = BacklogDraft(text: "Use the second design")
        draft.starredAt = Date()
        let active = ThreadSummary(id: "active", title: "Working", status: .running)
        let sections = ThreadSections.build([draft, active], now: Date())
        XCTAssertEqual(sections.backlog.map(\.id), ["draft"])
        XCTAssertTrue(sections.starred.isEmpty)
        XCTAssertTrue(sections.inbox.isEmpty)
        XCTAssertTrue(sections.needsYou.isEmpty)
        XCTAssertEqual(sections.running.map(\.id), ["active"])
        XCTAssertEqual(sections.matching("homepage").backlog.map(\.id), ["draft"])
        let restored = try JSONDecoder().decode(ThreadSummary.self, from: JSONEncoder().encode(draft))
        XCTAssertEqual(restored.backlog, draft.backlog)
        draft.backlog = nil
        draft.status = .running
        draft.starredAt = nil
        XCTAssertEqual(ThreadSections.build([draft], now: Date()).running.map(\.id), ["draft"])
    }

    func testArchivedDraftReturnsToBacklogWhenRestored() {
        var draft = ThreadSummary(id: "draft", title: "Later", archivedAt: Date())
        draft.backlog = BacklogDraft(text: "A prepared prompt")
        XCTAssertEqual(ThreadSections.build([draft], now: Date()).archived.count, 1)
        draft.archivedAt = nil
        XCTAssertEqual(ThreadSections.build([draft], now: Date()).backlog.count, 1)
    }
}
