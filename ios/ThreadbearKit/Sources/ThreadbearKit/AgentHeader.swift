import Foundation

/// The line the runner starts a message from another thread's agent with,
/// `[Sent by the agent in the thread "<title>" (<id8>)]`, or the `then` of
/// a thread's own move, `[Sent by the agent before moving to <folder>]`
/// (docs/protocol/tools.md, "Tools for agents"). The runner gives these no
/// origin, so this line is the only thing saying they aren't Mike's, and
/// the phone draws them as a card rather than his bubble, as the Mac does
/// (`AgentHeader` in ThreadbearCore, which this follows).
public struct AgentHeader: Sendable, Hashable {
    /// The sending thread's title and id (its first 8 characters); empty
    /// for a move's `then`, which this thread's agent sent.
    public var title: String
    public var threadId: String
    /// For a move's `then`: the folder the thread moved to.
    public var movedTo: String?
    /// The message without the header line.
    public var body: String

    public init?(_ text: String) {
        let lines = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        guard let first = lines.first?.trimmingCharacters(in: .whitespaces) else { return nil }
        let thread = "[Sent by the agent in the thread \""
        let move = "[Sent by the agent before moving to "
        if first.hasPrefix(thread), first.hasSuffix(")]") {
            let inner = first.dropFirst(thread.count).dropLast(2)
            // The title may hold quotes and brackets; the id never holds `" (`.
            guard let split = inner.range(of: "\" (", options: .backwards) else { return nil }
            title = String(inner[..<split.lowerBound])
            threadId = String(inner[split.upperBound...])
        } else if first.hasPrefix(move), first.hasSuffix("]"), first.count > move.count + 1 {
            title = ""
            threadId = ""
            movedTo = String(first.dropFirst(move.count).dropLast())
        } else {
            return nil
        }
        body = lines.count > 1 ? String(lines[1]).trimmingCharacters(in: .newlines) : ""
    }
}

extension PhoneMessage {
    /// Set for a user message an agent wrote (another thread's, or this
    /// one's before a move). Only for messages with no origin, as the Mac.
    public var agentHeader: AgentHeader? {
        role == .user && origin == nil ? AgentHeader(text) : nil
    }
}
