import SwiftUI
import ThreadbearKit

/// The quick ask screen, over whatever was showing: what you're saying while listening, then the
/// answer as it streams in and is spoken. Tap anywhere to send, or to stop it talking.
struct QuickAskView: View {
    @Environment(QuickAskModel.self) private var quick
    /// Opens the thread the answer was kept in.
    var openThread: (String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                CircleButton(systemImage: "xmark", label: "Close") { quick.close() }
                Spacer()
            }
            .padding(.horizontal, 20)
            .frame(height: 52)

            ScrollView {
                content
                    .padding(.horizontal, 24)
                    .padding(.top, 8)
                    .padding(.bottom, 24)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .defaultScrollAnchor(.top)

            BottomBar(openThread: openThread)
        }
        .background(Color(.systemBackground).ignoresSafeArea())
        .contentShape(Rectangle())
        .onTapGesture { quick.tapAnywhere() }
        .animation(.easeInOut(duration: 0.2), value: quick.phase)
    }

    @ViewBuilder private var content: some View {
        switch quick.phase {
        case .needsPermission(let state):
            PermissionNote(state: state)
        case .idle(let notice):
            if let notice {
                Text(notice)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .padding(.top, 24)
            }
        case .listening:
            Text(quick.transcript.isEmpty ? "Listening" : quick.transcript)
                .font(.system(size: 32, weight: .semibold))
                .foregroundStyle(quick.transcript.isEmpty ? .tertiary : .primary)
                .lineSpacing(2)
                .padding(.top, 24)
                .contentTransition(.opacity)
                .animation(.easeOut(duration: 0.12), value: quick.transcript)
        case .thinking, .answering, .done:
            AnswerBody()
        case .failed(let failure):
            VStack(alignment: .leading, spacing: 16) {
                if !quick.question.isEmpty {
                    Text(quick.question)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Text(failure.message)
                    .font(.title3)
            }
            .padding(.top, 8)
        }
    }
}

/// The question, then the answer as it streams, its sources.
private struct AnswerBody: View {
    @Environment(QuickAskModel.self) private var quick

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(quick.question)
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if quick.phase == .thinking {
                ThinkingDots().padding(.vertical, 6)
            } else {
                Text(quick.answer.trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(.system(size: 24))
                    .lineSpacing(4)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            if quick.waitingStage != nil {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Still searching")
            }

            if !quick.sources.isEmpty, quick.phase != .thinking {
                FlowChips(sources: quick.sources)
            }

            if let problem = quick.keepProblem {
                Label("Couldn't keep this as a thread: \(problem)", systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Sources as quiet chips that open the archived conversation or the web page.
private struct FlowChips: View {
    var sources: [AnswerSource]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(sources) { source in
                if let url = URL(string: source.url) {
                    Link(destination: url) {
                        HStack(spacing: 6) {
                            Image(systemName: source.isWeb ? "globe" : "text.bubble")
                            Text(source.isWeb ? source.title : [source.title, source.displayDate].filter { !$0.isEmpty }.joined(separator: " · "))
                                .lineLimit(1)
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(source.isWeb ? "Opens the web page" : "Opens the conversation")
                }
            }
        }
    }
}

private struct BottomBar: View {
    @Environment(QuickAskModel.self) private var quick
    var openThread: (String) -> Void
    @State private var showingTimings = false

    var body: some View {
        HStack {
            CircleButton(systemImage: "arrow.up.right", label: "Open the thread") {
                if let id = quick.threadId { openThread(id) }
            }
            .opacity(quick.threadId == nil ? 0 : 1)
            .disabled(quick.threadId == nil)
            .frame(width: 80, alignment: .leading)

            Spacer()
            QuickMicButton(level: quick.level, isListening: quick.phase == .listening, action: quick.micButton)
            Spacer()

            Button { showingTimings = true } label: {
                HStack(spacing: 4) {
                    if let ms = quick.timing?.endToFirstWord { Text(TimingFormat.duration(ms)) }
                    Image(systemName: "info.circle")
                }
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .opacity(quick.timing?.endToFirstWord == nil ? 0 : 1)
            .frame(width: 80, alignment: .trailing)
            .accessibilityLabel("Timings")
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 8)
        .sheet(isPresented: $showingTimings) {
            if let timing = quick.timing {
                TimingSheet(timing: timing).presentationDetents([.medium])
            }
        }
    }
}

/// What each part of the wait took, for tuning: from the end of your speech to the first word.
private struct TimingSheet: View {
    var timing: QuestionTiming

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(Array(timing.breakdown.enumerated()), id: \.offset) { _, row in
                        LabeledContent(row.label.trimmingCharacters(in: .whitespaces), value: row.value)
                            .foregroundStyle(row.label.hasPrefix(" ") ? .secondary : .primary)
                    }
                } footer: {
                    Text("\(timing.trigger.label) · \(timing.transcriber). The question goes to your Ask server, and the answer into a thread on your Mac.")
                }
            }
            .font(.subheadline)
            .navigationTitle("Timings")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct PermissionNote: View {
    @Environment(QuickAskModel.self) private var quick
    var state: Permissions.State

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(state == .denied
                 ? "Ask needs the microphone and speech recognition. Turn them on for Threadbear in Settings."
                 : "Ask listens for your question, and turns it into text on the phone where it can.")
                .font(.title3)
            Button(state == .denied ? "Open Settings" : "Allow") {
                state == .denied ? quick.openSystemSettings() : quick.requestPermissions()
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(.top, 24)
    }
}

private struct CircleButton: View {
    var systemImage: String
    var label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 38, height: 38)
                .background(Color.primary.opacity(0.07), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// The big round button. While listening it's ringed by two soft circles that swell with your voice.
private struct QuickMicButton: View {
    var level: Double
    var isListening: Bool
    var action: () -> Void

    private let size: CGFloat = 74

    var body: some View {
        Button(action: action) {
            ZStack {
                if isListening {
                    Circle()
                        .fill(Color.accentColor.opacity(0.14))
                        .frame(width: size, height: size)
                        .scaleEffect(1.15 + level * 0.75)
                    Circle()
                        .stroke(Color.accentColor.opacity(0.45), lineWidth: 2)
                        .frame(width: size, height: size)
                        .scaleEffect(1.08 + level * 0.35)
                }
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: size, height: size)
                Group {
                    if isListening {
                        Image(systemName: "waveform").symbolEffect(.variableColor.iterative, options: .repeating)
                    } else {
                        Image(systemName: "mic.fill")
                    }
                }
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.white)
            }
            .frame(width: 150, height: 140)
            .contentShape(Circle().scale(0.6))
            .animation(.easeOut(duration: 0.12), value: level)
            .animation(.spring(duration: 0.3), value: isListening)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isListening ? "Send" : "Ask another")
    }
}

private struct ThinkingDots: View {
    @State private var on = false

    var body: some View {
        HStack(spacing: 8) {
            ForEach(0..<3) { index in
                Circle()
                    .fill(.tertiary)
                    .frame(width: 9, height: 9)
                    .opacity(on ? 1 : 0.3)
                    .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(index) * 0.2), value: on)
            }
        }
        .onAppear { on = true }
        .accessibilityLabel("Thinking")
    }
}

/// Settings › Ask: where questions go, and how answers sound.
struct QuickAskSettingsSection: View {
    @Environment(QuickAskModel.self) private var quick
    @State private var tokenDraft = ""
    @State private var showingAbout = false
    @State private var scanning = false
    /// What the scanner read, looked at once its sheet has gone, so the alert
    /// isn't put up while the sheet is still leaving.
    @State private var scanned: String?
    /// A setup code waiting for a yes: every one is asked about, the first included.
    @State private var confirming: QuickAskSetup?
    /// Trading the code for a token: the buttons wait, with a spinner.
    @State private var claiming = false
    @State private var problem: (title: String, message: String)?

    var body: some View {
        @Bindable var settings = quick.settings
        Section {
            TextField("Server address", text: $settings.baseURLString)
                .textContentType(.URL)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit { quick.settingsChanged() }
            // The server's setup code (`npm run phone-token -- issue --bruce --qr` for
            // Agent Archive): read by this scanner only, never the Camera, and traded
            // once for the token (QuickAskSetup).
            Button {
                scanning = true
            } label: {
                if claiming {
                    HStack { ProgressView(); Text("Setting up Ask…") }
                } else {
                    Label("Scan the code", systemImage: "qrcode.viewfinder")
                }
            }
            .disabled(claiming)
            Button("Paste a setup code") {
                let pasted = UIPasteboard.general.string ?? ""
                // Taken off the clipboard once read, where any app could read it too.
                if pasted.contains(QuickAskSetup.textPrefix) { UIPasteboard.general.items = [] }
                take(pasted)
            }
            .disabled(claiming)
            SecureField(settings.hasToken ? "Token saved" : "Token", text: $tokenDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit {
                    settings.setToken(tokenDraft)
                    tokenDraft = ""
                    quick.settingsChanged()
                }
            if settings.isReady {
                Toggle("Speak answers", isOn: $settings.speakAnswers)
                Stepper("Send after \(settings.silenceMs) ms quiet", value: $settings.silenceMs,
                        in: QuickAskSettings.silenceRange, step: 100)
                Button("Hear the voice") { quick.playVoiceSample() }
                if let median = quick.timings.log.medianEndToFirstWord {
                    LabeledContent("Usual wait", value: TimingFormat.duration(median))
                }
                Button("Forget this server", role: .destructive) {
                    settings.forget()
                    quick.settingsChanged()
                }
            }
        } header: {
            HStack {
                Text("Ask")
                Spacer()
                Button { showingAbout = true } label: { Image(systemName: "info.circle") }
                    .accessibilityLabel("About Ask")
            }
        }
        .fullScreenCover(isPresented: $scanning, onDismiss: {
            if let code = scanned { take(code) }
            scanned = nil
        }) {
            // A setup code ends the scan, and so does an old Quick Ask link, to say
            // why it isn't taken; any other code in view is ignored.
            ScanSheet(accept: { $0.hasPrefix(QuickAskSetup.textPrefix) || $0.lowercased().hasPrefix("threadbear://quickask") }) { code in
                scanned = code
            }
        }
        .alert(confirming.map { "Use Quick Ask on \($0.hostName)?" } ?? "",
               isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
               presenting: confirming) { setup in
            Button("Use \(setup.hostName)") {
                confirming = nil
                claim(setup)
            }
            Button("Cancel", role: .cancel) { confirming = nil }
        } message: { setup in
            Text(setup.confirmMessage(current: settings.baseURL))
        }
        .alert(problem?.title ?? "", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) { problem = nil }
        } message: {
            Text(problem?.message ?? "")
        }
        .alert("Ask", isPresented: $showingAbout) {
            // There's no public server yet (Mike's is Agent Archive), so this is how anyone else gets one.
            Button("How to set one up") {
                LinkGate.shared.openOwn(URL(string: "https://github.com/mikecann/threadbear/blob/main/docs/ask-server.md")!)
            }
            Button("OK", role: .cancel) {}
        } message: {
            Text("Press the Action button (set it to Threadbear's Ask shortcut), say a question, and hear the answer from your own Ask server. Each answer is kept as a thread on your Mac, so you can carry on there.")
        }
    }

    /// A scanned or pasted code: a setup code is asked about, anything else says why not.
    private func take(_ raw: String) {
        switch QuickAskSetup.parse(raw) {
        case .success(let setup): confirming = setup
        case .failure(.link): problem = ("Threadbear doesn't take Quick Ask links", QuickAskSetup.linkRefusal)
        case .failure(.unusable): problem = ("This code can't be used", "It isn't a whole Quick Ask setup code, or its server isn't a secure (https) address. Nothing was changed.")
        case .failure(.notQuickAsk): problem = ("That isn't a Quick Ask setup code", "Make one on your Ask server and scan it here. Nothing was changed.")
        }
    }

    /// Trades the code for the token, once, then keeps both. Nothing on the phone changes
    /// on a failure, but the server may have taken the code (and retired the old token)
    /// before the answer was lost, so a failure says to make a new code.
    private func claim(_ setup: QuickAskSetup) {
        guard let request = setup.claimRequest() else { return }
        claiming = true
        Task {
            defer { claiming = false }
            let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }
            do {
                let (data, response) = try await session.data(for: request)
                let http = response as? HTTPURLResponse
                switch setup.token(status: http?.statusCode ?? 0, body: data, answeredFrom: http?.url) {
                case .success(let token):
                    quick.settings.apply(setup, token: token)
                    quick.settingsChanged()
                case .failure(let failure):
                    problem = ("Ask wasn't set up", "\(failure.message) Nothing on this phone was changed.")
                }
            } catch {
                problem = ("Ask wasn't set up", "Couldn't hear back from \(setup.hostName) (\(error.localizedDescription)). Nothing on this phone was changed, but the server may have taken the code: if Ask stops working, make a new code and scan it.")
            }
        }
    }
}

/// The claim goes to the code's own server and nowhere else: a redirect isn't followed.
/// The completion-handler form, off the main actor: Swift 6.4's compiler crashes lowering
/// the async form in this main-actor-by-default target.
private nonisolated final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
