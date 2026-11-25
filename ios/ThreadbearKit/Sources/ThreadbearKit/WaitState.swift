import Foundation

/// What a thread is waiting on, as the runner works it out and sends on each
/// row (`waitState`, docs/protocol/needs-you.md, "Wait state";
/// runner/src/wait-state.ts). The phone draws it instead of working it out
/// from a dozen fields: the section, the Needs you order and the badge all
/// come from it and the turn's status. Rows from a runner before 23 Nov 2026
/// have none and fall back to the old rule (`InboxSections.legacySection`).
public enum WaitState: String, Sendable, CaseIterable {
    case working, job, onThreads, landing, appRestart, sending
    case card, review, needsYou, limit, done
    case scheduled, hibernating
    case archived

    /// A value this build doesn't know is drawn as done.
    public init(wire: String) {
        self = WaitState(rawValue: wire) ?? .done
    }

    /// The heading it goes under, before a star takes it to Starred.
    public var section: PhoneSection {
        switch self {
        case .working, .job, .onThreads, .landing, .appRestart, .sending: .running
        case .card, .review, .needsYou, .limit, .done: .inbox
        case .scheduled, .hibernating: .hibernating
        case .archived: .archived
        }
    }

    /// The Inbox's Needs you order, lowest first: 0 stuck on Mike (a card,
    /// a review), 1 asking him after a failed or stopped turn, 2 asking him
    /// (read or not: Mike, 23 Nov) or out of usage, 3 done after a failed or
    /// stopped turn, 4 done or not in the Inbox.
    public func urgency(status: ThreadStatus) -> Int {
        let broken = status == .error || status == .stopped
        switch self {
        case .card, .review: return 0
        case .needsYou: return broken ? 1 : 2
        case .limit: return 2
        case .done: return broken ? 3 : 4
        default: return 4
        }
    }

    /// Whether it counts in the badge and the Needs you filter.
    public func counts(status: ThreadStatus) -> Bool { urgency(status: status) <= 2 }
}

extension PhoneThread {
    /// The runner's wait state, nil from a runner before 23 Nov.
    public var wait: WaitState? { waitState.map(WaitState.init(wire:)) }
}
