import XCTest
import ThreadbearCore
@testable import Threadbear

final class BacklogComposerTests: XCTestCase {
    @MainActor func testFilesSurviveNormalizationRestoreAndPictureRemoval() {
        let app = AppModel()
        let file = AttachmentRef(id: "f", path: "/local/f.pdf", name: "report.pdf", mediaType: "application/pdf", size: 30_000_000, sha256: String(repeating: "b", count: 64))
        let image = ImageRef(path: "/local/p.png", mediaType: "image/png")
        var thread = ThreadSummary(id: "files", title: "Files")
        thread.backlog = BacklogDraft(text: "", attachments: [file])
        app.threads[thread.id] = thread
        app.restoreBacklog(thread.id)
        XCTAssertEqual(app.drafts[thread.id]?.attachments, [file])
        XCTAssertFalse(app.hasUnsavedComposerDrafts)
        var draft = app.drafts[thread.id]!
        draft.append([image])
        XCTAssertEqual(draft.normalized.attachments, [file])
        XCTAssertEqual(draft.removingImage(at: 0).attachments, [file])
        app.drafts[thread.id]?.attachments = []
        XCTAssertTrue(app.hasUnsavedComposerDrafts)
    }

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
