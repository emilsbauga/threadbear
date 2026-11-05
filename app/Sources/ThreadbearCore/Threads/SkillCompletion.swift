import Foundation

public struct ComposerSkill: Codable, Sendable, Equatable, Identifiable {
    public var name: String
    public var title: String?
    public var description: String
    public var path: String
    public var scope: String
    public var id: String { path }
    public var displayName: String { title ?? name }
    public var scopeLabel: String {
        switch scope {
        case "user": "Personal"
        case "repo": "Project"
        case "system": "Built-in"
        case "admin": "Managed"
        default: scope.capitalized
        }
    }
    public init(name: String, title: String? = nil, description: String, path: String, scope: String) {
        self.name = name; self.title = title; self.description = description; self.path = path; self.scope = scope
    }
}

public struct ComposerSkills: Decodable, Sendable {
    public var skills: [ComposerSkill]
    public var errors: [String]
}

public enum SkillCompletion {
    public struct Token: Equatable, Sendable {
        public var range: NSRange
        public var query: String
    }

    /// A slash search (including spaces), or dollar word beside the cursor.
    /// URLs, file paths and searches crossing a newline are excluded.
    /// Offsets match NSTextView, including emoji and attachment characters.
    public static func token(in text: String, selection: NSRange) -> Token? {
        let ns = text as NSString
        guard selection.length == 0, selection.location > 0, selection.location <= ns.length else { return nil }
        let before = ns.substring(to: selection.location) as NSString
        let marker = before.rangeOfCharacter(from: CharacterSet(charactersIn: "/$"), options: .backwards)
        guard marker.location != NSNotFound else { return nil }
        let start = marker.location
        if start > 0, let preceding = UnicodeScalar(ns.character(at: start - 1)), !CharacterSet.whitespacesAndNewlines.contains(preceding) { return nil }
        let query = before.substring(from: start + 1)
        var allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_:."))
        // Slash searches can use the words shown in a skill's title. Dollar
        // mentions still end at a space, including one inserted by selection.
        if ns.character(at: start) == 0x2F { allowed.insert(charactersIn: " ") }
        guard query.unicodeScalars.allSatisfy({ allowed.contains($0) }) else { return nil }
        // Don't replace half a word if the cursor was moved into its middle.
        if selection.location < ns.length, let scalar = UnicodeScalar(ns.character(at: selection.location)), !CharacterSet.whitespacesAndNewlines.contains(scalar) { return nil }
        return Token(range: NSRange(location: start, length: selection.location - start), query: query)
    }

    public static func matches(_ skills: [ComposerSkill], query: String) -> [ComposerSkill] {
        func normalized(_ text: String) -> String {
            text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
                .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
        }
        let query = normalized(query)
        let words = query.split(separator: " ").map(String.init)
        func titleRank(_ text: String) -> Int? {
            if text == query { return 0 }
            if text.hasPrefix(query) { return 10 }
            let titleWords = text.split(separator: " ")
            if words.allSatisfy({ word in titleWords.contains { $0.hasPrefix(word) } }) { return 20 }
            if text.contains(query) { return 30 }
            if words.allSatisfy({ text.contains($0) }) { return 40 }
            return nil
        }
        let ranked = skills.compactMap { skill -> (skill: ComposerSkill, rank: Int)? in
            if query.isEmpty { return (skill, 0) }
            // The displayed title comes first. Internal names remain searchable
            // aliases; descriptions only fill in results with no title match.
            if let rank = titleRank(normalized(skill.displayName)) { return (skill, rank) }
            if let rank = titleRank(normalized(skill.name)) { return (skill, 50 + rank) }
            let all = normalized("\(skill.displayName) \(skill.name) \(skill.description)")
            return words.allSatisfy { all.contains($0) } ? (skill, 100) : nil
        }
        return ranked.sorted {
            if $0.rank != $1.rank { return $0.rank < $1.rank }
            let order = $0.skill.displayName.localizedStandardCompare($1.skill.displayName)
            return order == .orderedSame ? $0.skill.path < $1.skill.path : order == .orderedAscending
        }.map(\.skill)
    }
}
