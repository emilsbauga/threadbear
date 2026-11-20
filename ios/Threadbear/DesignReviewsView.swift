import SwiftUI
import ThreadbearKit

struct DesignReviewTarget: Identifiable {
    var id: String // Empty opens the pending list.
}

/// The review stays separate from the transcript's folded working.
struct DesignReviewsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let threadId: String
    let reviewId: String
    @State private var entries: [DesignReviewResult.Entry] = []
    @State private var review: PhoneDesignReview?
    @State private var draft = DesignReviewDraft()
    @Binding var drafts: [String: DesignReviewDraft]
    @State private var pictures: [MessageImage] = []
    @State private var loading = true
    @State private var sending = false
    @State private var problem: String?
    @State private var truncated = false
    @State private var imageReload = 0

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if loading {
                        ProgressView("Waiting for the thread's runner…")
                            .frame(maxWidth: .infinity).padding()
                        Text("The runner must be online to read or answer a review.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let problem {
                        Text(problem).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently)
                        Button("Reload review") {
                            Task { await load(review?.id ?? (reviewId.isEmpty ? nil : reviewId), preserveDraft: true) }
                        }
                        .disabled(loading || sending)
                    }
                    if let review {
                        reviewBody(review)
                    } else if !loading {
                        if entries.isEmpty {
                            ContentUnavailableView("No pending reviews", systemImage: "checkmark.circle")
                        }
                        ForEach(entries) { entry in
                            Button {
                                Task { await load(entry.id) }
                            } label: {
                                HStack {
                                    Text(entry.title).multilineTextAlignment(.leading)
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                }.padding(.vertical, 8)
                            }
                            .accessibilityHint("Opens the design options")
                        }
                        if truncated { Text("Showing the first 100 reviews. Answer these to see the rest.").font(.footnote) }
                    }
                }
                .padding()
            }
            .navigationTitle(review?.title ?? "Reviews")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                if review != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("All reviews") {
                            if let review { drafts[review.id] = draft }
                            Task { await load(nil) }
                        }.disabled(loading || sending)
                    }
                }
            }
            .onChange(of: draft) { _, value in
                if let review { drafts[review.id] = value }
            }
            .task { await load(reviewId.isEmpty ? nil : reviewId) }
            .task(id: "\(review?.id ?? ""):\(model.connection):\(imageReload)") { await followPictures() }
        }
    }

    @ViewBuilder private func reviewBody(_ review: PhoneDesignReview) -> some View {
        if let note = review.note { MarkdownText(note) }
        if !review.pending {
            Text("This review is \(review.status). Your notes stay here for reference.")
                .font(.callout).foregroundStyle(.secondary)
        }
        ForEach(review.options) { option in
            VStack(alignment: .leading, spacing: 12) {
                Text("\(option.id). \(option.title)").font(.headline)
                if option.reference == true { Text("Reference only").font(.caption).foregroundStyle(.secondary) }
                if review.recommended == option.id { Text("Recommended").font(.caption).fontWeight(.semibold) }
                if let note = option.note { MarkdownText(note) }
                ForEach(Array(option.shots.enumerated()), id: \.offset) { _, shot in
                    if let title = shot.title { Text(title).font(.subheadline) }
                    if shot.preview == false {
                        Label("No preview on the phone. Open it on the Mac.", systemImage: "photo")
                            .font(.footnote).foregroundStyle(.secondary)
                    } else if let picture = pictures.first(where: { $0.src == shot.src }), let url = URL(string: picture.url),
                       (["https", "http"].contains(url.scheme?.lowercased() ?? "") || (model.isFake && url.isFileURL)) {
                        ReplyPicture(url: url, alt: "\(option.title): \(shot.title ?? "Preview")", width: picture.width, height: picture.height)
                    } else {
                        Label("The preview is on its way from the Mac.", systemImage: "photo")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if shot.kind != "image" {
                        Text("\(shot.kind == "video" ? "Video" : "Page") still preview. Open the original on the Mac.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if option.reference != true {
                    Toggle("Choose \(option.title)", isOn: Binding(
                        get: { draft.picks.contains(option.id) },
                        set: { draft.pick(option.id, selected: $0) }
                    )).disabled(!review.pending || loading || sending)
                }
                TextField("Notes on \(option.title)", text: Binding(
                    get: { draft.notes[option.id] ?? "" },
                    set: { draft.notes[option.id] = $0 }
                ), axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .disabled(!review.pending || loading || sending)
            }
            .padding()
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        }
        if review.pending {
            Toggle("None of these", isOn: Binding(get: { draft.none == true }, set: { draft.pickNone($0) }))
                .disabled(loading || sending)
            TextField("Reply", text: Binding(get: { draft.reply ?? "" }, set: { draft.reply = $0 }), axis: .vertical)
                .textFieldStyle(.roundedBorder).disabled(loading || sending)
            Text("Pick any options, none, or write a reply. Notes can be up to 4,000 characters each; replies up to 8,000.")
                .font(.footnote).foregroundStyle(.secondary)
            Button {
                Task { await send(review) }
            } label: {
                HStack {
                    if sending { ProgressView() }
                    Text(sending ? "Sending answer…" : "Send answer")
                }.frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(loading || sending || !draft.canSend(to: review))
        }
    }

    private func load(_ id: String?, preserveDraft: Bool = false) async {
        guard let backend = model.backend else { loading = false; problem = "Reconnect to Threadbear to read reviews."; return }
        guard model.hasDesignReviews else {
            loading = false
            problem = "Update Threadbear's backend on the Mac to read reviews here."
            return
        }
        loading = true
        if !preserveDraft { problem = nil }
        defer { loading = false }
        do {
            let command = try await backend.designReviews(threadId: threadId, reviewId: id)
            guard let status = await model.commandOutcome(command), !Task.isCancelled else { return }
            guard status.state == .done, let result = status.designReviews else {
                throw TransportError.server(status.note ?? "Couldn't load the review. Try again.")
            }
            if let loaded = result.review {
                let kept = preserveDraft && review?.id == loaded.id
                review = loaded
                imageReload += 1
                if !kept { draft = drafts[loaded.id] ?? loaded.draft }
            } else if let list = result.reviews {
                entries = list
                truncated = result.truncated == true
                review = nil
            } else { throw TransportError.server("Couldn't read the review. Try again.") }
        } catch { problem = error.localizedDescription }
    }

    private func followPictures() async {
        guard let review, let backend = model.backend else { return }
        pictures = []
        do {
            for try await images in backend.reviewImages(threadId: threadId, sources: review.sources) {
                if Task.isCancelled { return }
                pictures = images
            }
        } catch {
            if !Task.isCancelled { problem = "Couldn't load the review pictures. Your answer is still here. \(error.localizedDescription)" }
        }
    }

    private func send(_ review: PhoneDesignReview) async {
        guard !sending, draft.canSend(to: review), let backend = model.backend else { return }
        sending = true
        problem = nil
        defer { sending = false }
        do {
            let command = try await backend.respondReview(threadId: threadId, review: review, draft: draft)
            guard let status = await model.commandOutcome(command) else { return }
            guard status.state == .done else { throw TransportError.server(status.note ?? "The answer wasn't accepted.") }
            dismiss()
        } catch {
            problem = "\(error.localizedDescription) Your answer is kept. Reload before sending again."
            // Never retry a write automatically against a newer revision.
            await load(review.id, preserveDraft: true)
        }
    }
}
