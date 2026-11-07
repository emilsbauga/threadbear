import XCTest
import ThreadbearCore
@testable import Threadbear

final class BacklogComposerTests: XCTestCase {
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
        app.drafts["new"] = Draft(text: "Not saved")
        XCTAssertTrue(app.hasUnsavedComposerDrafts)
        app.drafts["new"] = nil
        XCTAssertFalse(app.hasUnsavedComposerDrafts)
    }
}
