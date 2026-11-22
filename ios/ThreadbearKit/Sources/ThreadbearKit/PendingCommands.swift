import Foundation
import Observation

/// Every command this phone has on its way, by what it's about (CommandKey),
/// and the one watcher that moves each through PendingCommand: it sends,
/// follows the command's row on whichever Convex client is current (`use`
/// moves every watch onto a new one, so coming back from the background or a
/// pull to refresh doesn't leave one listening to a client that never
/// answers), times it out, and lets go a moment after it's done. A control
/// reads its state here (`self[key]`) and shows it: spinning while locked,
/// its change kept while `holdsChange`, the failure where it is.
@MainActor @Observable
public final class PendingCommands {
    public struct Entry: Equatable, Sendable {
        public var state: PendingCommand
        /// What was asked for, for the control to show at once: a new title,
        /// "on" or "off" for a star, the button tapped on a card.
        public var value: String?
    }

    public private(set) var entries: [CommandKey: Entry] = [:]
    @ObservationIgnored private var runs: [CommandKey: Run] = [:]
    @ObservationIgnored private var backend: (any Backend)?
    /// How long until nothing heard is timed out; short in tests.
    @ObservationIgnored public var deadline: TimeInterval = PendingCommand.deadlineSeconds
    /// How long a subscription that failed waits to try again.
    @ObservationIgnored public var retryAfter: Duration = .seconds(2)
    /// A refused token: the app goes back to pairing.
    @ObservationIgnored public var unauthorized: ((String) -> Void)?
    private let now: () -> Date

    public init(now: @escaping () -> Date = { .now }) {
        self.now = now
    }

    public subscript(key: CommandKey) -> PendingCommand { entries[key]?.state ?? .idle }

    public func value(_ key: CommandKey) -> String? { entries[key]?.value }

    /// Each command's own work: the send, the row's subscription, the clock.
    @MainActor private final class Run {
        let token = UUID()
        var send: Task<Void, Never>?
        var watch: Task<Void, Never>?
        var clock: Task<Void, Never>?
        var settle: Task<Void, Never>?
        let settleAfter: Duration?
        let then: ((PendingCommand) -> Void)?
        var sent: ((String) -> Void)?
        /// `outcome`'s caller, waiting for where it ends.
        var waiter: CheckedContinuation<PendingCommand, Never>?
        var waitsThroughTimeOuts = false
        init(settleAfter: Duration?, then: ((PendingCommand) -> Void)?) {
            self.settleAfter = settleAfter
            self.then = then
        }
        func cancel() {
            [send, watch, clock, settle].forEach { $0?.cancel() }
            // Let go of, or replaced: the caller stops waiting.
            waiter?.resume(returning: .idle)
            waiter = nil
        }

        func ended(_ state: PendingCommand) {
            guard state.isFinished || (state.isTimedOut && !waitsThroughTimeOuts) else { return }
            waiter?.resume(returning: state)
            waiter = nil
        }
    }

    /// The backend commands go to and are heard from. A different one (a
    /// fresh client) moves every command still waiting onto it; nil (unpaired)
    /// lets go of them all.
    public func use(_ backend: (any Backend)?) {
        let had = self.backend != nil
        self.backend = backend
        guard backend != nil else { return clear() }
        guard had else { return }
        for (key, run) in runs {
            apply(.reconnected(at: now()), to: key, run: run)
            if let id = self[key].id, self[key].isWaiting { watch(id, key: key, run: run) }
        }
    }

    /// Sends a command, unless one about the same thing is still locked.
    /// `then` hears it end: done, failed, or timed out (which can still end
    /// in done or failed later). Done lets go after `settle`, or with nil only
    /// at `forget`. `sent` hears the command's id once the backend has it.
    @discardableResult
    public func start(_ key: CommandKey, value: String? = nil, settle: Duration? = .seconds(3),
                      send: @escaping @Sendable (any Backend) async throws -> String,
                      then: ((PendingCommand) -> Void)? = nil,
                      sent: ((String) -> Void)? = nil) -> Bool {
        guard let backend, !self[key].locked else { return false }
        runs.removeValue(forKey: key)?.cancel()
        let run = Run(settleAfter: settle, then: then)
        run.sent = sent
        runs[key] = run
        entries[key] = Entry(state: .idle, value: value)
        apply(.tap(at: now()), to: key, run: run)
        run.send = Task { [weak self] in
            do {
                let id = try await send(backend)
                guard let self, self.runs[key] === run else { return }
                self.apply(.sent(id: id, at: self.now()), to: key, run: run)
                guard case .queued = self[key] else { return }
                run.sent?(id)
                self.watch(id, key: key, run: run)
            } catch {
                guard let self, self.runs[key] === run else { return }
                if case let TransportError.unauthorized(message) = error { self.unauthorized?(message) }
                self.apply(.sendFailed(reason: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription), to: key, run: run)
            }
        }
        return true
    }

    /// Follows a command sent some other way (the composer's), as if `start`
    /// had sent it: for a control that waits on it.
    public func adopt(_ key: CommandKey, commandId: String, value: String? = nil, settle: Duration? = .seconds(3),
                      then: ((PendingCommand) -> Void)? = nil) {
        guard backend != nil else { return }
        runs.removeValue(forKey: key)?.cancel()
        let run = Run(settleAfter: settle, then: then)
        runs[key] = run
        entries[key] = Entry(state: .idle, value: value)
        let at = now()
        apply(.tap(at: at), to: key, run: run)
        apply(.sent(id: commandId, at: at), to: key, run: run)
        watch(commandId, key: key, run: run)
    }

    /// Follows a command sent some other way and waits for where it ends:
    /// done, failed, timed out (unless `throughTimeOuts`), or idle if it's
    /// let go of or replaced by another about the same thing first.
    public func outcome(_ key: CommandKey, commandId: String, throughTimeOuts: Bool = false) async -> PendingCommand {
        guard backend != nil, !Task.isCancelled else { return .idle }
        // The caller leaving (its view gone) lets go of the watch, rather than
        // leaving it, and the caller, waiting for the Mac.
        return await withTaskCancellationHandler {
            await withCheckedContinuation { waiter in
                adopt(key, commandId: commandId, settle: .zero)
                guard let run = runs[key] else { return waiter.resume(returning: self[key]) }
                let now = self[key]
                if now.isFinished || (now.isTimedOut && !throughTimeOuts) { return waiter.resume(returning: now) }
                run.waiter = waiter
                run.waitsThroughTimeOuts = throughTimeOuts
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, self[key].id == commandId else { return }
                self.forget(key)
            }
        }
    }

    /// The backend took it back.
    public func cancelled(_ key: CommandKey) {
        guard let run = runs[key] else { return }
        apply(.cancelled, to: key, run: run)
    }

    /// Lets go of one, whatever it's doing: the row it was about has caught up.
    public func forget(_ key: CommandKey) {
        runs.removeValue(forKey: key)?.cancel()
        entries[key] = nil
    }

    /// Lets go of every one matching, as `forget`.
    public func forget(where match: (CommandKey) -> Bool) {
        for key in entries.keys where match(key) { forget(key) }
    }

    /// Unpaired, or leaving the demo: nothing of the old pairing's stays.
    public func clear() {
        runs.values.forEach { $0.cancel() }
        runs = [:]
        entries = [:]
    }

    // MARK: The watcher

    private func apply(_ event: PendingCommand.Event, to key: CommandKey, run: Run) {
        guard runs[key] === run, var entry = entries[key] else { return }
        let before = entry.state
        let after = before.step(event, deadline: deadline)
        guard after != before else { return }
        entry.state = after
        if after == .idle {
            runs.removeValue(forKey: key)?.cancel()
            entries[key] = nil
            return
        }
        entries[key] = entry
        arm(key, run: run)
        run.ended(after)
        switch after {
        case .done:
            run.watch?.cancel()
            run.then?(after)
            guard let settleAfter = run.settleAfter else { break }
            run.settle = Task { [weak self] in
                try? await Task.sleep(for: settleAfter)
                guard !Task.isCancelled else { return }
                self?.apply(.settle, to: key, run: run)
            }
        case .failed:
            run.watch?.cancel()
            run.then?(after)
        case .timedOut:
            run.then?(after)
        case .idle, .sending, .queued, .taken:
            break
        }
    }

    /// The clock, set for the state's deadline, if it has one.
    private func arm(_ key: CommandKey, run: Run) {
        run.clock?.cancel()
        guard let at = self[key].deadlineAt(deadline) else { return }
        run.clock = Task { [weak self] in
            let wait = at.timeIntervalSince(self?.now() ?? at)
            if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            guard !Task.isCancelled, let self else { return }
            self.apply(.deadline(at: max(self.now(), at)), to: key, run: run)
        }
    }

    /// The command's row on the current backend, until it's done or failed.
    /// A subscription that fails or ends is tried again on whatever's current.
    private func watch(_ id: String, key: CommandKey, run: Run) {
        run.watch?.cancel()
        run.watch = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let backend = self.backend else { return }
                do {
                    for try await row in backend.command(id) {
                        guard !Task.isCancelled else { return }
                        self.apply(.row(row, at: self.now()), to: key, run: run)
                        if self.runs[key] !== run || self[key].isFinished { return }
                    }
                } catch TransportError.unauthorized(let message) {
                    self.unauthorized?(message)
                    return
                } catch {}
                try? await Task.sleep(for: self.retryAfter)
            }
        }
    }
}
