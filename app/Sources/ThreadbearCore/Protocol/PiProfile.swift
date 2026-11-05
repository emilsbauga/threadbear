import Foundation

/// Configuration metadata only. Profiles are not runnable accounts until
/// the runner supplies an adapter and advertises threads support.
public struct PiProfile: Sendable, Hashable, Decodable, Identifiable {
    public var id: String
    public var engine: String
    public var title: String
    public var executable: String
    public var configDir: String
    public var connection: PiModelConnection
    public var capabilities: PiProfileCapabilities
}

public struct PiModelConnection: Sendable, Hashable, Decodable {
    public var provider: String
    public var model: String
}

public struct PiProfileCapabilities: Sendable, Hashable, Decodable {
    public var threads: Bool
}
