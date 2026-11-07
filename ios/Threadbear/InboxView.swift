import SwiftUI
import ThreadbearKit

/// How many cards are in the Pocket: grey once they've all been seen, the
/// accent colour when one's been filed or changed since.
private struct PocketBadge: View {
    var count: Int
    var hasNew: Bool

    var body: some View {
        if count > 0 {
            Text(count, format: .number)
                .font(.system(size: 10, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(.white)
                .padding(.horizontal, 4)
                .frame(minWidth: 15, minHeight: 15)
                .background(hasNew ? Color.accentColor : Color.gray, in: .capsule)
                .allowsHitTesting(false)
        }
    }
}

struct InboxView: View {
    @Environment(AppModel.self) private var model
    @Environment(QuickAskModel.self) private var quick
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var path: [String] = []
    @State private var composing = false
    @State private var composeText = ""
    @State private var hibernateTarget: PhoneThread?
    @State private var query = ""
    @State private var olderArchived: [PhoneThread] = []
    @State private var pocketOpen = false
    @State private var afterPocket: PocketView.Next?
    /// The thread a new thread sheet just made, to open once the sheet has gone.
    @State private var afterCompose: String?

    private var pocketValue: String {
        let count = model.pocket.count
        guard count > 0 else { return "Empty" }
        return "\(count) \(count == 1 ? "card" : "cards")\(model.pocketHasNew ? ", new since you last looked" : "")"
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let problem = model.backendProblem {
                    Section {
                        Label(problem, systemImage: "arrow.down.circle")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                if let offline = model.offlineText {
                    Section {
                        Label(offline, systemImage: "moon.zzz")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } footer: {
                        Text("Anything you send waits until it's back.")
                    }
                }
                let sections = model.sections
                if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                    results(ThreadSearch(query, sections: sections, hibernating: model.hibernating, archived: model.den, olderArchived: olderArchived))
                } else if !model.loaded.contains(.inbox) {
                    LoadingRows()
                } else if sections.isEmpty {
                    ContentUnavailableView {
                        Label { Text("Nothing in the inbox") } icon: { BearView(pose: .sit, size: 44) }
                    } description: {
                        Text("Threads that finish or need you turn up here.")
                    }
                    .listRowBackground(Color.clear)
                }
                if query.trimmingCharacters(in: .whitespaces).isEmpty, model.loaded.contains(.inbox) {
                    ForEach(PhoneSection.allCases, id: \.self) { section($0) }
                }
            }
            // A flat list with the Mac sidebar's headings, not grouped cards.
            .listStyle(.plain)
            .listSectionSeparator(.hidden)
            // Folded headings sit one under another, without the gap an
            // empty section would leave.
            .listSectionSpacing(0)
            .navigationTitle("Threadbear")
            // Always showing, rather than tucked under the title until you
            // pull down: on the phone it's the quickest way to an old thread.
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
            // The phone has only the newest 100 archived threads, so Convex
            // looks through the rest, once typing pauses.
            .task(id: query) {
                olderArchived = []
                let text = query.trimmingCharacters(in: .whitespaces)
                guard !text.isEmpty else { return }
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled else { return }
                let found = await model.searchOlderArchived(text)
                if !Task.isCancelled { olderArchived = found }
            }
            .navigationDestination(for: String.self) { ThreadView(threadId: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        NavigationLink { SettingsView() } label: { Label("Settings", systemImage: "gear") }
                        if model.isFake {
                            Button { model.leaveDemo() } label: {
                                Label("Leave the demo", systemImage: "rectangle.portrait.and.arrow.right")
                            }
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal")
                    }
                }
                if model.showsPocket {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { pocketOpen = true } label: {
                            // A frame with room for the badge: the toolbar clips a
                            // button's label to its bounds, so an offset badge lost its top.
                            Image(systemName: "wallet.pass")
                                .frame(width: 44, height: 36)
                                .overlay(alignment: .topTrailing) {
                                    PocketBadge(count: model.pocket.count, hasNew: model.pocketHasNew)
                                }
                                .compositingGroup()
                        }
                        .accessibilityLabel("Pocket")
                        .accessibilityValue(pocketValue)
                    }
                }
                if quick.settings.isReady {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { quick.open() } label: { Image(systemName: "waveform") }
                            .accessibilityLabel("Ask")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                        .accessibilityLabel("New thread")
                }
            }
            .fullScreenCover(isPresented: $pocketOpen, onDismiss: {
                // Only once the cover has gone: nothing else can present
                // or push while it's still up.
                switch afterPocket {
                case let .thread(id): path.append(id)
                case .add: model.composeText = "Add to my pocket: "
                case nil: break
                }
                afterPocket = nil
            }) {
                PocketView { afterPocket = $0 }
            }
            .onAppear {
                if model.opensPocketAtLaunch {
                    model.opensPocketAtLaunch = false
                    pocketOpen = true
                }
            }
            .sheet(isPresented: $composing, onDismiss: {
                composeText = ""
                // Only once the sheet has gone, as with the Pocket's cover. Pushed while
                // it was still sliding away with the keyboard, the thread could open
                // blank on the phone until you went back and in again.
                if let id = afterCompose { path.append(id) }
                afterCompose = nil
            }) {
                NewThreadView(text: composeText) { afterCompose = $0 }
            }
            .onChange(of: model.composeText, initial: true) { _, text in
                guard let text else { return }
                composeText = text
                composing = true
                model.composeText = nil
            }
            .hibernateDialog(for: $hibernateTarget)
            .refreshable { try? await Task.sleep(for: .milliseconds(400)) }
            .overlay(alignment: .bottom) { ConnectionToast() }
            .onChange(of: query, initial: true) { _, text in
                model.setSearching(!text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .onChange(of: model.searchText, initial: true) { _, text in
                guard let text else { return }
                query = text
                model.searchText = nil
            }
            .onChange(of: model.openThreadId, initial: true) { _, id in
                guard let id else { return }
                path = [id]
                model.openThreadId = nil
            }
        }
        .environment(\.pushThread) { path.append($0) }
    }

    /// A heading and its rows, as on the Mac's sidebar: tap the heading to
    /// fold it away, and folded it says how many it hides. Empty sections
    /// are left out, Inbox aside, which has the empty view above instead.
    @ViewBuilder private func section(_ section: PhoneSection) -> some View {
        let folded = model.folds.isFolded(section)
        let count = model.count(section)
        let threads = model.threads(section)
        // A folded put-away section with no count (an older backend) still
        // shows its heading, so there's a way to open it.
        if section != .inbox, section == .backlog || count != 0 || (count == nil && section.view != nil) {
            Section {
                if !folded {
                    if section == .hibernating {
                        // The scheduled ones are in the inbox list already;
                        // the snoozed ones load once it's opened.
                        hibernatingRows(threads)
                        if !model.loaded.contains(.hibernating) { LoadingRows(count: 3) }
                    } else if let view = section.view {
                        if !model.loaded.contains(view) {
                            LoadingRows(count: 3)
                        } else {
                            putAwayRows(threads, from: view)
                        }
                    } else {
                        rows(threads, running: section == .running, starred: section == .starred)
                    }
                }
            } header: {
                // A tap rather than a Button: a button in a list header
                // is drawn dimmed, so the heading looked disabled.
                SectionHeading(title: section.title, icon: section.icon, fold: .init(folded: folded, count: count))
                    .onTapGesture { withAnimation(.snappy(duration: 0.2)) { model.toggle(section) } }
                    .accessibilityAction { model.toggle(section) }
                    .accessibilityHint(folded ? "Shows these threads" : "Hides these threads")
            }
        } else if section == .inbox, !threads.isEmpty {
            Section { rows(threads) } header: { SectionHeading(title: section.title, icon: section.icon) }
        }
    }

    /// What the search found, under the same headings as the Mac's sidebar,
    /// the put-away threads too.
    @ViewBuilder private func results(_ search: ThreadSearch) -> some View {
        if search.isEmpty {
            ContentUnavailableView.search(text: query.trimmingCharacters(in: .whitespaces))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        }
        if !search.backlog.isEmpty {
            Section { rows(search.backlog) } header: { SectionHeading(title: "Backlog", icon: "tray.full") }
        }
        if !search.starred.isEmpty {
            Section { rows(search.starred, starred: true) } header: { SectionHeading(title: "Starred", icon: "star") }
        }
        if !search.inbox.isEmpty {
            Section { rows(search.inbox) } header: { SectionHeading(title: "Inbox", icon: "tray") }
        }
        if !search.running.isEmpty {
            Section { rows(search.running, running: true) } header: { SectionHeading(title: "Running", icon: "bolt") }
        }
        if !search.hibernating.isEmpty {
            Section { hibernatingRows(search.hibernating) } header: { SectionHeading(title: "Hibernating", icon: "moon.zzz") }
        }
        if !search.archived.isEmpty {
            Section { putAwayRows(search.archived, from: .den) } header: { SectionHeading(title: "Archived", icon: "archivebox") }
        }
    }

    /// Hibernating or archived rows: open on a tap, and swipe to bring
    /// back.
    private func putAwayRows(_ threads: [PhoneThread], from view: ThreadsView) -> some View {
        ForEach(threads) { putAwayRow($0, from: view) }
    }

    private func putAwayRow(_ thread: PhoneThread, from view: ThreadsView) -> some View {
        Button { path.append(thread.threadId) } label: { ThreadRow(thread: thread) }
            .buttonStyle(.plain)
            .listRowInsets(ThreadRow.insets)
            .listRowSeparator(.hidden)
            .bringBackSwipe(thread, from: view)
    }

    /// Under Hibernating, snoozed threads wake with a swipe. One only
    /// waiting on a schedule isn't snoozed, so it gets an inbox row that
    /// says when the schedule runs, and can be hibernated for real.
    private func hibernatingRows(_ threads: [PhoneThread]) -> some View {
        ForEach(threads) { thread in
            if InboxSections.isSnoozed(thread, now: model.now) {
                putAwayRow(thread, from: .hibernating)
            } else {
                row(thread, scheduled: true)
            }
        }
    }

    private func rows(_ threads: [PhoneThread], running: Bool = false, starred: Bool = false) -> some View {
        ForEach(threads) { row($0, running: running, starred: starred) }
    }

    @ViewBuilder private func row(_ thread: PhoneThread, running: Bool = false, scheduled: Bool = false, starred: Bool = false) -> some View {
        // Only under Starred can a row be asleep: elsewhere it's in Hibernating.
        let asleep = starred && InboxSections.isSnoozed(thread, now: model.now)
        // A plain row, not a NavigationLink: the Mac's rows have no
        // chevron, and the status sits where it would go.
        Button { path.append(thread.threadId) } label: {
            ThreadRow(thread: thread, underRunning: running, wake: scheduled ? model.wakes[thread.threadId] : nil, asleep: asleep)
                // Off to the left, the way a swipe to archive goes.
                .offset(x: model.slidingOff.contains(thread.threadId) && !reduceMotion ? -500 : 0)
                .opacity(model.slidingOff.contains(thread.threadId) ? 0 : 1)
        }
        .buttonStyle(.plain)
        .listRowInsets(ThreadRow.insets)
        .listRowSeparator(.hidden)
        .swipeActions(edge: .trailing) {
            Button { model.archive(thread.threadId) } label: { Label("Archive", systemImage: "archivebox") }
                .tint(.brown)
        }
        .swipeActions(edge: .leading) {
            if asleep {
                Button { Task { await perform(thread, .wake) } } label: { Label("Wake", systemImage: "sun.max") }
                    .tint(.accentColor)
            } else {
                Button { hibernateTarget = thread } label: { Label("Hibernate", systemImage: "moon.zzz") }
                    .tint(.indigo)
            }
            if model.canStar { starButton(thread).tint(.yellow) }
        }
        .contextMenu {
            if model.canStar { starButton(thread) }
            if asleep {
                Button { Task { await perform(thread, .wake) } } label: { Label("Wake", systemImage: "sun.max") }
            } else {
                Button { hibernateTarget = thread } label: { Label("Hibernate…", systemImage: "moon.zzz") }
            }
            Button { model.archive(thread.threadId) } label: { Label("Archive", systemImage: "archivebox") }
            if thread.unread || thread.needsYou {
                Button { Task { await perform(thread, .markSeen) } } label: { Label("Mark as read", systemImage: "envelope.open") }
            }
        }
    }

    private func starButton(_ thread: PhoneThread) -> some View {
        let starred = thread.starredAt != nil
        return Button { Task { await perform(thread, .star(!starred)) } } label: {
            Label(starred ? "Remove Star" : "Star", systemImage: starred ? "star.slash" : "star")
        }
    }

    private func perform(_ thread: PhoneThread, _ change: ThreadChange) async {
        guard let backend = model.backend else { return }
        do { _ = try await backend.update(threadId: thread.threadId, change: change) } catch { model.report(error) }
    }
}

extension View {
    /// Wake a hibernating thread, or put an archived one back in the inbox.
    func bringBackSwipe(_ thread: PhoneThread, from view: ThreadsView) -> some View {
        modifier(BringBackSwipe(thread: thread, view: view))
    }
}

private struct BringBackSwipe: ViewModifier {
    @Environment(AppModel.self) private var model
    var thread: PhoneThread
    var view: ThreadsView

    func body(content: Content) -> some View {
        content.swipeActions(edge: .trailing) {
            Button {
                Task {
                    guard let backend = model.backend else { return }
                    do { _ = try await backend.update(threadId: thread.threadId, change: view == .den ? .unarchive : .wake) }
                    catch { model.report(error) }
                }
            } label: {
                Label(view == .den ? "Back to inbox" : "Wake", systemImage: view == .den ? "tray.and.arrow.up" : "sun.max")
            }
            .tint(.accentColor)
        }
    }
}

/// A row as the Mac sidebar draws one: the project's tile two lines tall,
/// the title across the width, and under it where the thread belongs and
/// what it's doing, with the unread dot (or the done tick) in the gutter
/// left of the tile.
struct ThreadRow: View {
    @Environment(AppModel.self) private var model
    var thread: PhoneThread
    /// Under the Running heading a working row shows just its spinner and
    /// time, as on the Mac: the heading says what it's doing.
    var underRunning = false
    /// Under the Waiting heading, the schedule that messages it next: the
    /// row says when, where the time would be, as on the Mac.
    var wake: PhoneSchedule?
    /// Under Starred and hibernating: a moon says so, as there's no heading to.
    var asleep = false

    /// Room on the left for the gutter mark; the trailing edge like the Mac's.
    static let insets = EdgeInsets(top: 6, leading: 28, bottom: 6, trailing: 16)

    var body: some View {
        let kind = RowStatus.kind(thread)
        HStack(alignment: .center, spacing: 10) {
            ProjectTiles(projects: thread.projects ?? [])
                .overlay(alignment: .leading) {
                    if done {
                        // Finished with nothing needed: a tick where the
                        // unread dot would be.
                        Image(systemName: "checkmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 10, height: 10)
                            .offset(x: -19)
                            .accessibilityLabel("Done, unread")
                    } else if unread {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 7, height: 7)
                            .offset(x: -17)
                            .accessibilityLabel("Needs you")
                    }
                }
            VStack(alignment: .leading, spacing: 3) {
                Text(thread.title.isEmpty ? "Untitled" : thread.title)
                    .font(.body.weight(emphasised ? .semibold : .regular))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        if let startedBy = thread.startedBy {
                            // Mike didn't start it: the mark alone says so,
                            // before the place every row names.
                            Image(systemName: UIImage(systemName: startedBy.symbol) == nil ? "wrench.and.screwdriver" : startedBy.symbol)
                                .font(.footnote)
                                .accessibilityLabel(thread.bylineText ?? startedBy.label)
                        }
                        Text(line2)
                            .font(.subheadline)
                            .lineLimit(1)
                    }
                    .foregroundStyle(.secondary)
                    Spacer(minLength: 6)
                    if asleep {
                        Image(systemName: "moon.zzz").font(.footnote).foregroundStyle(Look.faint).accessibilityLabel("Hibernating")
                    }
                    trailing(kind)
                }
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    /// The Mac's ThreadRowLook, as far as the phone's row knows: unread
    /// with nothing waiting on Mike is "done" (a tick); needing him, a dot.
    private var done: Bool { RowStatus.kind(thread) == .time && thread.unread && !thread.needsYou }
    private var unread: Bool {
        let kind = RowStatus.kind(thread)
        return kind == .needsYou || (thread.needsYou && kind != .working) || done
    }
    private var emphasised: Bool { thread.needsYou || RowStatus.kind(thread) == .needsYou || done }

    private var line2: String {
        var parts = [thread.placeText]
        if let runner = model.runnerName(thread.runnerId) { parts.append(runner) }
        if let working = thread.working, thread.isBusy || (thread.pendingApproval == nil && !thread.waitingOnMike) { parts.append(working) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private func trailing(_ kind: RowStatus.Kind) -> some View {
        switch kind {
        case .working:
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                ProgressView()
                    .controlSize(.mini)
                    .tint(.accentColor)
                    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                // How long the turn has run, ticking once a second.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let elapsed = RowStatus.workingLabel(since: thread.lastActivityAt, now: context.date)
                    Text(underRunning ? elapsed : "Working " + elapsed)
                        .monospacedDigit()
                        .contentTransition(.numericText(countsDown: false))
                        .animation(.default, value: elapsed)
                }
            }
            .font(.footnote.weight(.medium))
            .foregroundStyle(Color.accentColor)
        case .needsYou:
            // The dot before the tile says it, as on the Mac.
            Text(RelativeTime.short(thread.lastActivityAt, now: model.now)).font(.footnote).monospacedDigit().foregroundStyle(Look.faint)
        case .failed:
            Text("Failed").font(.footnote.weight(.medium)).foregroundStyle(Look.failed)
        case .waitingForConnection:
            // Its turn lost the internet; it carries on by itself.
            Text(RowStatus.text(thread, now: model.now)).font(.footnote).foregroundStyle(Look.faint).lineLimit(1)
        case .stopped:
            Text("Stopped").font(.footnote).foregroundStyle(.secondary)
        case .time where thread.woke != nil:
            // Back from hibernating by itself; the time comes back once
            // it's been opened.
            Text(RowStatus.text(thread, now: model.now)).font(.footnote.weight(.medium)).foregroundStyle(Color.accentColor)
        case .time where wake?.nextRunAt != nil:
            // When its schedule messages it next: "10:42", "Mon 10:42".
            Text(RelativeTime.clock(wake?.nextRunAt ?? model.now, now: model.now))
                .font(.footnote).monospacedDigit().foregroundStyle(Look.faint)
                .accessibilityLabel("Scheduled: \(wake?.whenText ?? "")")
        case .time:
            Text(RowStatus.text(thread, now: model.now)).font(.footnote).monospacedDigit().foregroundStyle(Look.faint)
        }
    }
}

/// A small note at the bottom when Convex can't be reached, or a call failed.
struct ConnectionToast: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if !model.connected {
                toast("Reconnecting…", icon: "wifi.slash")
            } else if let error = model.lastError {
                toast(error, icon: "exclamationmark.triangle")
                    .onTapGesture { model.clearError() }
                    .task(id: error) {
                        try? await Task.sleep(for: .seconds(6))
                        model.clearError()
                    }
            }
        }
        .animation(.default, value: model.connected)
        .animation(.default, value: model.lastError)
    }

    private func toast(_ text: String, icon: String) -> some View {
        Label(text, systemImage: icon)
            .font(.footnote)
            .lineLimit(2)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .padding(.bottom, 12)
            .padding(.horizontal)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

extension View {
    /// The Hibernate presets as a dialog, for a swipe or a menu.
    func hibernateDialog(for target: Binding<PhoneThread?>) -> some View {
        modifier(HibernateDialog(target: target))
    }
}

private struct HibernateDialog: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var target: PhoneThread?

    func body(content: Content) -> some View {
        content.confirmationDialog("Hibernate until", isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
                                   titleVisibility: .visible, presenting: target) { thread in
            ForEach(Hibernate.presets(now: .now)) { preset in
                Button(preset.title) { change(thread, .snooze(until: preset.date)) }
            }
            Button("Until the runner restarts") { change(thread, .snoozeUntilRestart) }
        }
    }

    private func change(_ thread: PhoneThread, _ change: ThreadChange) {
        Task {
            guard let backend = model.backend else { return }
            do { _ = try await backend.update(threadId: thread.threadId, change: change) } catch { model.report(error) }
        }
    }
}

/// Grey placeholder rows, shaped like thread rows, while a list waits for
/// its first answer from Convex, so a list that's loading doesn't look
/// empty.
struct LoadingRows: View {
    var count = 6
    @State private var dim = false

    var body: some View {
        ForEach(0..<count, id: \.self) { i in
            HStack(alignment: .center, spacing: 10) {
                RoundedRectangle(cornerRadius: 5).frame(width: 22, height: 22)
                VStack(alignment: .leading, spacing: 7) {
                    // Varied widths, so it reads as rows of titles rather than bars.
                    Capsule().frame(width: [190, 150, 220, 170, 130, 200][i % 6], height: 11)
                    Capsule().frame(width: [110, 90, 130, 80, 120, 100][i % 6], height: 9)
                }
                Spacer()
                Capsule().frame(width: 24, height: 9)
            }
            .foregroundStyle(Color(.tertiarySystemFill))
            .opacity(dim ? 0.45 : 1)
            .listRowInsets(ThreadRow.insets)
            .listRowSeparator(.hidden)
            .accessibilityHidden(true)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityElement()
        .accessibilityLabel("Loading threads")
    }
}
