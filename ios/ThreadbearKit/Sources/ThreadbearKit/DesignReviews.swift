import Foundation

/// The runner's review, with private image sources instead of file paths.
public struct PhoneDesignReview: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var note: String?
    public var recommended: String?
    public var status: String
    public var revision: Double
    public var draft: DesignReviewDraft
    public var options: [Option]

    public struct Option: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var title: String
        public var note: String?
        public var reference: Bool?
        public var shots: [Shot]
    }

    public struct Shot: Codable, Sendable, Hashable {
        public var src: String
        public var title: String?
        public var kind: String
        /// False when the runner can't send this still (gone, or not a
        /// picture even shrunk), so the sheet says so rather than waiting.
        public var preview: Bool?
    }

    public var sources: [String] { Array(Set(options.flatMap { $0.shots.map(\.src) })).sorted() }
    public var pending: Bool { status == "pending" }
}

public struct DesignReviewDraft: Codable, Sendable, Hashable {
    public var pickedId: String?
    public var pickedIds: [String]?
    public var notes: [String: String]
    public var reply: String?
    public var none: Bool?

    public init() { notes = [:] }
    public var picks: Set<String> { Set(pickedIds ?? pickedId.map { [$0] } ?? []) }

    public mutating func pick(_ id: String, selected: Bool) {
        var chosen = picks
        if selected { chosen.insert(id); none = nil } else { chosen.remove(id) }
        pickedIds = chosen.sorted()
        pickedId = pickedIds?.first
    }

    public mutating func pickNone(_ selected: Bool) {
        none = selected ? true : nil
        if selected { pickedId = nil; pickedIds = nil }
    }

    public func canSend(to review: PhoneDesignReview) -> Bool {
        let known = Set(review.options.map(\.id))
        let pickable = Set(review.options.filter { $0.reference != true }.map(\.id))
        guard review.pending, review.revision.isFinite, review.revision >= 0,
              review.revision.rounded() == review.revision,
              picks.isSubset(of: pickable), Set(notes.keys).isSubset(of: known),
              !(none == true && !picks.isEmpty),
              (reply?.utf16.count ?? 0) <= 8000, notes.values.allSatisfy({ $0.utf16.count <= 4000 }) else { return false }
        return !picks.isEmpty || none == true || !(reply ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
            notes.values.contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    /// phone:respondReview's draft. Notes go as a list: an option id can be
    /// any text, and Convex refuses an object key that isn't plain ASCII or
    /// starts with "$".
    public var arguments: JSONValue {
        let noteList = notes.keys.sorted().map { JSONValue.object(["id": .string($0), "text": .string(notes[$0] ?? "")]) }
        var args: [String: JSONValue] = ["notes": .array(noteList)]
        if let pickedIds { args["pickedIds"] = .array(pickedIds.map(JSONValue.string)) }
        else if let pickedId { args["pickedId"] = .string(pickedId) }
        if let reply { args["reply"] = .string(reply) }
        if none == true { args["none"] = .bool(true) }
        return .object(args)
    }
}

public struct DesignReviewResult: Codable, Sendable, Hashable {
    public struct Entry: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var title: String
    }
    public var reviews: [Entry]?
    public var review: PhoneDesignReview?
    public var truncated: Bool?
}
