import XCTest
import ThreadbearCore
@testable import Threadbear

final class BacklogComposerTests: XCTestCase {
    @MainActor func testAutosavePreservesWhitespaceWhileContinuingToType() async throws {
        let app = AppModel()
        let transport = BacklogTransport()
        let client = RPCClient(transport: transport)
        try await client.start()
        defer { client.close() }
        app.useClientForTesting(client)
        let image = ImageRef(path: "/local/p.png", mediaType: "image/png")
        var thread = ThreadSummary(id: "typing", title: "Typing")
        thread.backlog = BacklogDraft(text: "Original")
        app.threads[thread.id] = thread
        app.restoreBacklog(thread.id)
        transport.answers["threads.saveDraft"] = { params in
            ["thread": ["id": "typing", "title": "Typing", "backlog": [
                "text": params["text"] ?? "", "images": params["images"] ?? [],
                "revision": (params["revision"] as? Int ?? 0) + 1,
            ]]]
        }
        // Pause at word boundaries, then continue typing. Also exercise
        // indentation, newlines and whitespace beside picture chips.
        for draft in [Draft(text: "Original "), Draft(text: "Original next "),
                      Draft(text: "  Original next\n\n"),
                      Draft(text: "\n\(InlinePictures.markString) ", images: [image]),
                      Draft(text: " \n")] {
            app.drafts[thread.id] = draft
            app.saveBacklogChanges(thread.id)
            let deadline = Date().addingTimeInterval(5)
            while app.backlogSaves[thread.id] != nil && Date() < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertNil(app.backlogSaves[thread.id])
            XCTAssertEqual(app.drafts[thread.id], draft)
            XCTAssertEqual(app.threads[thread.id]?.backlog?.text, InlinePictures.messageText(draft.text))
            XCTAssertFalse(app.hasUnsavedComposerDrafts)
        }
    }

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

private final class BacklogTransport: RPCTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [Data] = []
    private var waiter: CheckedContinuation<Data, Error>?
    private var sent: [(method: String, params: [String: Any])] = []
    var answers: [String: ([String: Any]) -> [String: Any]] = [:]

    func open() async throws {}

    func send(_ text: String) async throws {
        guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let method = object["method"] as? String else { return }
        let params = object["params"] as? [String: Any] ?? [:]
        lock.withLock { sent.append((method, params)) }
        // The auth handshake has no id; nothing to answer.
        guard let id = object["id"] else { return }
        let result = answers[method]?(params) ?? [:]
        push(["jsonrpc": "2.0", "id": id, "result": result])
    }

    func params(_ method: String) -> [[String: Any]] {
        lock.withLock { sent.filter { $0.method == method }.map(\.params) }
    }

    func receive() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if !inbox.isEmpty {
                let data = inbox.removeFirst()
                lock.unlock()
                continuation.resume(returning: data)
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    func close() {
        lock.lock()
        let waiting = waiter
        waiter = nil
        lock.unlock()
        waiting?.resume(throwing: RPCError.disconnected("closed"))
    }

    private func push(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        lock.lock()
        if let waiting = waiter {
            waiter = nil
            lock.unlock()
            waiting.resume(returning: data)
        } else {
            inbox.append(data)
            lock.unlock()
        }
    }
}
