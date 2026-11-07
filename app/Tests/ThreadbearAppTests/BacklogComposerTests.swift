import XCTest
import ThreadbearCore
@testable import Threadbear

final class BacklogComposerTests: XCTestCase {
    @MainActor func testDeleteActionsStayOutOfActiveRowsAndForgetClearsDraft() {
        let app = AppModel()
        var thread = ThreadSummary(id: "delete-draft", title: "Disposable")
        thread.backlog = BacklogDraft(text: "Saved", images: [])
        app.threads[thread.id] = thread
        app.restoreBacklog(thread.id)
        XCTAssertTrue(RowMode(.backlog, thread: thread, now: Date()).rowActions.contains(.delete))
        XCTAssertTrue(RowMode.archive.rowActions.contains(.delete))
        XCTAssertFalse(RowMode.inbox.rowActions.contains(.delete))
        XCTAssertFalse(RowMode.hibernating.rowActions.contains(.delete))
        XCTAssertFalse(RowMode.projects.rowActions.contains(.delete))
        app.forget(thread.id)
        XCTAssertNil(app.threads[thread.id])
        XCTAssertNil(app.drafts[thread.id])
    }

    @MainActor func testSavedDraftRestoresPicturesAndDoesNotHoldUpAppUpdates() {
        let app = AppModel()
        var thread = ThreadSummary(id: "backlog-test", title: "A saved prompt")
        let image = ImageRef(path: "/tmp/backlog-picture.png", mediaType: "image/png")
        thread.backlog = BacklogDraft(text: "Check [Picture 1]", images: [image])
        app.threads[thread.id] = thread
        app.restoreBacklog(thread.id)
        XCTAssertEqual(app.drafts[thread.id]?.images, [image])
        XCTAssertEqual(app.drafts[thread.id]?.words(), "Check [Picture 1]")
        XCTAssertFalse(app.hasUnsavedComposerDrafts)
        // An annotation is separate from the editable prompt. Receiving one
        // must not dirty the composer or hold up the idle app updater.
        thread.backlog?.context = "Use the existing typography tokens"
        app.threads[thread.id] = thread
        app.restoreBacklog(thread.id)
        XCTAssertEqual(app.drafts[thread.id]?.words(), "Check [Picture 1]")
        XCTAssertFalse(app.hasUnsavedComposerDrafts)
        app.drafts["new"] = Draft(text: "Not saved")
        XCTAssertTrue(app.hasUnsavedComposerDrafts)
        app.drafts["new"] = nil
        XCTAssertFalse(app.hasUnsavedComposerDrafts)
    }
}
