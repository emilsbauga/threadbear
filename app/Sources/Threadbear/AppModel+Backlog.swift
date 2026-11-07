import Foundation
import ThreadbearCore

extension AppModel {
    var hasUnsavedComposerDrafts: Bool {
        drafts.contains { id, draft in
            if let saved = threads[id]?.backlog { return draft.normalized != Self.composerDraft(saved) }
            return !draft.text.isEmpty || !draft.images.isEmpty
        }
    }

    static func composerDraft(_ saved: BacklogDraft) -> Draft {
        let value = InlinePictures.draft(text: saved.text, images: saved.images)
        return Draft(text: value.text, images: value.images).normalized
    }

    func restoreBacklog(_ id: String, replacing: Bool = false) {
        guard let saved = threads[id]?.backlog, replacing || drafts[id] == nil else { return }
        drafts[id] = Self.composerDraft(saved)
    }

    func saveToBacklog() {
        guard !creatingThread, newThreadRunnerId == nil else { return }
        guard let client, connection == .connected else {
            errorMessage = "Connect to the runner to save to Backlog."
            return
        }
        let draft = (drafts["new"] ?? Draft()).normalized
        guard !draft.words().isEmpty || !draft.images.isEmpty else { return }
        let request = newThreadRequest(text: draft.words(), images: draft.images)
        creatingThread = true
        Task {
            defer { creatingThread = false }
            do {
                let thread = try await client.createThread(request, backlog: true)
                threads[thread.id] = thread
                drafts["new"] = nil
                newThreadCwd = nil
                newThreadPermission = .full
                newThreadAccount = nil
                newThreadPool = nil
                newThreadProvider = nil
                collapsedSections.remove(.backlog)
                select(thread.id)
                focusComposer(thread.id)
            } catch { show(error) }
        }
    }

    /// One writer per draft. Edits made while a save is in flight are sent
    /// afterward, never overwritten by the earlier response.
    func saveBacklogChanges(_ id: String) {
        guard backlogSaves[id] == nil, !startingBacklog.contains(id),
              let saved = threads[id]?.backlog, drafts[id]?.normalized != Self.composerDraft(saved) else { return }
        backlogSaves[id] = Task {
            defer { backlogSaves[id] = nil }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(300))
                guard !startingBacklog.contains(id), let saved = threads[id]?.backlog,
                      let draft = drafts[id]?.normalized, draft != Self.composerDraft(saved),
                      let client = client(for: id) else { return }
                do {
                    let thread = try await client.saveDraft(threadId: id, text: draft.words(), images: draft.images, revision: saved.revision)
                    guard !startingBacklog.contains(id), threads[id]?.backlog != nil else { return }
                    threads[id] = thread
                    // Replace transient inbox paths only if the user has
                    // not edited this draft while the save was in flight.
                    if drafts[id]?.normalized == draft { restoreBacklog(id, replacing: true) }
                    if drafts[id]?.normalized == thread.backlog.map(Self.composerDraft) { return }
                } catch {
                    if !startingBacklog.contains(id), threads[id]?.backlog != nil { show(error) }
                    return
                }
            }
        }
    }

    func startBacklog(_ id: String) {
        guard !startingBacklog.contains(id), let client = client(for: id) else { return }
        let draft = (drafts[id] ?? threads[id]?.backlog.map(Self.composerDraft) ?? Draft()).normalized
        guard !draft.words().isEmpty || !draft.images.isEmpty else { return }
        startingBacklog.insert(id)
        Task {
            defer { startingBacklog.remove(id) }
            do {
                try await client.send(threadId: id, text: draft.words(), images: draft.images)
                // The runner's thread.updated normally arrives first. Clear
                // the marker here too so a delayed notification cannot let
                // a second Return send the first prompt a second time.
                threads[id]?.backlog = nil
                drafts[id] = nil
            } catch {
                show(error)
            }
        }
    }
}
