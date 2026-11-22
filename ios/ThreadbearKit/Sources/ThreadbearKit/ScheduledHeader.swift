import Foundation

/// The line a schedule's message starts with, `[Scheduled: "<title>",
/// <whenText>]` (docs/protocol/projects.md, "Schedules"). The phone draws these as a
/// card with a clock and the schedule's name, not as Mike's bubble with the
/// raw line (Mike, 20 Nov), following `ScheduledHeader` in ThreadbearCore.
public struct ScheduledHeader: Sendable, Hashable {
    public var title: String
    public var whenText: String
    /// The message without the header line.
    public var body: String

    public init?(_ text: String) {
        let lines = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        let lead = "[Scheduled: \""
        guard let first = lines.first?.trimmingCharacters(in: .whitespaces),
              first.hasPrefix(lead), first.hasSuffix("]") else { return nil }
        let inner = first.dropFirst(lead.count).dropLast()
        // The title may hold quotes and commas; the runner's words for the
        // time never hold `", `, so the last one splits them.
        guard let split = inner.range(of: "\", ", options: .backwards) else { return nil }
        title = String(inner[..<split.lowerBound])
        whenText = String(inner[split.upperBound...])
        body = lines.count > 1 ? String(lines[1]).trimmingCharacters(in: .whitespacesAndNewlines) : ""
    }
}

extension PhoneMessage {
    /// A message a schedule sent (origin "schedule"), drawn as a card.
    public var isFromSchedule: Bool { role == .user && origin == "schedule" }

    /// What a schedule's card says on top, and the words under it.
    public var scheduledCard: (label: String, body: String)? {
        guard isFromSchedule else { return nil }
        guard let header = ScheduledHeader(text) else {
            return ("Sent by a schedule", text.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        let name = header.title.isEmpty ? "Untitled" : header.title
        return (header.whenText.isEmpty ? name : "\(name) · \(header.whenText)", header.body)
    }
}
