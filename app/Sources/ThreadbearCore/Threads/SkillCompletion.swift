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
            text.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: " ")
        }
        let words = normalized(query).split(separator: " ").map(String.init)
        return skills.filter { skill in
            let haystack = normalized("\(skill.name) \(skill.displayName) \(skill.description)")
            return words.allSatisfy { haystack.localizedStandardContains($0) }
        }.sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }
}
