import SwiftUI
import ThreadbearKit

/// Sharing a thread by link, as the website's Share control (web/src/share.tsx)
/// and the Mac's share button: a switch, the link to copy or send with the
/// system share sheet, and New link. Each is a `share` command the thread's
/// runner applies (phone:share), so every tap shows at once
/// (ThreadSharing.shown) and comes back with why if it's refused, and the
/// controls take no more taps until it lands.
struct ShareThreadSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let thread: PhoneThread
    @State private var copied = false

    var body: some View {
        let state = model.sharing(thread)
        NavigationStack {
            Form {
                Section {
                    Toggle(isOn: Binding(get: { state.on }, set: { model.share(thread, $0 ? .on : .off) })) {
                        HStack(spacing: 8) {
                            Text("Share with a link")
                            if state.spinning == .on || state.spinning == .off { ProgressView() }
                        }
                    }
                    .disabled(state.busy)
                    .accessibilityHint(state.on ? "Stops sharing this thread" : "Makes a link anyone can read this thread with")
                } footer: {
                    Text(state.on
                        ? "Anyone with the link can read this thread, and new replies show up as they come in. No sign-in."
                        : "Only you can see this thread.")
                }
                if state.on {
                    Section {
                        if let link = state.link {
                            Text(link.absoluteString)
                                .font(.callout.monospaced())
                                .textSelection(.enabled)
                                .lineLimit(2)
                                .truncationMode(.middle)
                            Button { copy(link) } label: {
                                Label(copied ? "Copied" : "Copy Link", systemImage: copied ? "checkmark" : "doc.on.doc")
                            }
                            .accessibilityHint("Puts the link on the clipboard")
                            ShareLink(item: link, subject: Text(thread.title)) {
                                Label("Share Link…", systemImage: "square.and.arrow.up")
                            }
                            .accessibilityHint("Sends the link with Messages, Mail or another app")
                        } else if state.making {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text(thread.share?.isOn == true ? "Making a new link…" : "Making the link…")
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Text("The link is on the Mac and the website.")
                                .foregroundStyle(.secondary)
                        }
                    }
                    Section {
                        Button { model.share(thread, .newLink) } label: {
                            HStack(spacing: 8) {
                                Text("New Link")
                                if state.spinning == .newLink { ProgressView() }
                            }
                        }
                        .disabled(state.busy)
                        .accessibilityHint("Gives the thread a new link. The old link stops working.")
                    } footer: {
                        Text("The old link stops working.")
                    }
                }
                if let failure = state.failure {
                    Section {
                        Label(failure, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                } else if let note = state.note {
                    Section {
                        Label(note, systemImage: "clock")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Share")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .animation(.default, value: state)
        }
        .presentationDetents([.medium, .large])
    }

    private func copy(_ link: URL) {
        UIPasteboard.general.url = link
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}
