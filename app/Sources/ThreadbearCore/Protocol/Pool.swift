import Foundation

/// A named, ordered list of logins a thread can run on (docs/archive/pools-plan.md).
/// Mike picks a pool and a model; the runner picks the login for each turn
/// and moves the thread when one runs dry. A pool can mix providers: the
/// order of `accountIds` only decides which provider comes first.
public struct Pool: Sendable, Hashable, Codable, Identifiable {
    /// "claude", "codex", "convex", or a slug made when Mike added it.
    public var id: String
    public var title: String
    /// In order; may mix providers.
    public var accountIds: [String]
    /// A new thread in one of these (or a folder inside one) starts here.
    /// "~" is allowed.
    public var folders: [String]
    /// From the runner's code default rather than runner.json.
    public var builtIn: Bool
    /// An SF Symbol name Mike picked, or nil for `Pools.symbol`'s fallback.
    public var icon: String?

    public init(id: String, title: String, accountIds: [String], folders: [String] = [], builtIn: Bool = false, icon: String? = nil) {
        self.id = id
        self.title = title
        self.accountIds = accountIds
        self.folders = folders
        self.builtIn = builtIn
        self.icon = icon
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = ((try? c.decodeIfPresent(String.self, forKey: .title)) ?? nil) ?? id
        accountIds = c.lossyArray(String.self, forKey: .accountIds)
        folders = c.lossyArray(String.self, forKey: .folders)
        builtIn = ((try? c.decodeIfPresent(Bool.self, forKey: .builtIn)) ?? nil) ?? false
        icon = ((try? c.decodeIfPresent(String.self, forKey: .icon)) ?? nil).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// What `pools.save` sends: `folders`, `builtIn` and `icon` only when they say
    /// something, as the runner writes them.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(accountIds, forKey: .accountIds)
        if !folders.isEmpty { try c.encode(folders, forKey: .folders) }
        if builtIn { try c.encode(true, forKey: .builtIn) }
        if let icon { try c.encode(icon, forKey: .icon) }
    }

    enum CodingKeys: String, CodingKey { case id, title, accountIds, folders, builtIn, icon }

    public var jsonValue: JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(id), "title": .string(title), "accountIds": .array(accountIds.map { .string($0) }),
        ]
        if !folders.isEmpty { object["folders"] = .array(folders.map { .string($0) }) }
        if builtIn { object["builtIn"] = .bool(true) }
        if let icon { object["icon"] = .string(icon) }
        return .object(object)
    }
}

/// A pool thread with no login that has room: it carries on by itself at
/// `until` (ThreadSummary.waitingForRoom).
public struct WaitingForRoom: Sendable, Hashable, Codable {
    public var until: Date
    /// The login it's waiting on, when one is known.
    public var accountId: String?

    public init(until: Date, accountId: String? = nil) {
        self.until = until
        self.accountId = accountId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let text = try c.decodeIfPresent(String.self, forKey: .until), let date = ISO8601.parse(text) else {
            throw DecodingError.dataCorruptedError(forKey: .until, in: c, debugDescription: "until isn't a time")
        }
        until = date
        accountId = (try? c.decodeIfPresent(String.self, forKey: .accountId)) ?? nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ISO8601.format(until), forKey: .until)
        try c.encodeIfPresent(accountId, forKey: .accountId)
    }

    enum CodingKeys: String, CodingKey { case until, accountId }
}
