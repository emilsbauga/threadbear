import Foundation

/// How much of an interpolated value a quick ask log line keeps, as `os.Logger`'s `privacy:`.
nonisolated enum QuickAskLogPrivacy: Sendable { case `public`, `private` }

/// A quick ask log line, written the way `os.Logger` call sites are (a value, then `privacy: .public`).
/// What's said and heard, thread ids, tokens and errors' own words never go into one: a value is
/// kept only when it's a number, a Bool or marked `.public`; anything else is `<private>`, in the
/// system log and the file alike, so the private value never leaves the call. An error goes in
/// only as its category (`\(error: e)`): a URL error's code, or a quick ask failure's kind, never
/// its description, which can quote the server's reply or a transcript.
nonisolated struct QuickAskLogMessage: ExpressibleByStringInterpolation, Sendable {
    static let redacted = "<private>"

    struct Interpolation: StringInterpolationProtocol {
        var text = ""
        init(literalCapacity: Int, interpolationCount: Int) {}
        mutating func appendLiteral(_ literal: String) { text += literal }
        mutating func appendInterpolation(_ value: some BinaryInteger) { text += "\(value)" }
        mutating func appendInterpolation(_ value: Bool) { text += "\(value)" }
        mutating func appendInterpolation<T>(_ value: T, privacy: QuickAskLogPrivacy = .private) {
            text += privacy == .public ? "\(value)" : QuickAskLogMessage.redacted
        }
        mutating func appendInterpolation(error: any Error) { text += QuickAskLogMessage.category(of: error) }
    }

    /// Already redacted: safe for the system log as public and for the file.
    let text: String
    /// For literals written in the code. Swift makes it take a `String`, so `QuickAskLogTests` fails
    /// on any call that builds a message by hand instead of from a literal.
    init(stringLiteral value: String) { text = value }
    init(stringInterpolation: Interpolation) { text = stringInterpolation.text }

    static func category(of error: any Error) -> String {
        if let error = error as? QuickAskLogCategorized { return error.logCategory }
        let ns = error as NSError
        return "\(ns.domain) \(ns.code)"
    }
}

/// An error that says which kind it is, in words that never come from the server, the
/// transcript or the system's description.
nonisolated protocol QuickAskLogCategorized {
    var logCategory: String { get }
}

extension AskFailure: QuickAskLogCategorized {
    nonisolated var logCategory: String {
        switch self {
        case .noToken: "noToken"
        case .badBaseURL: "badBaseURL"
        case .unauthorized: "unauthorized"
        case .outOfCredit: "outOfCredit"
        case .rateLimited: "rateLimited"
        case .badRequest: "badRequest"
        case .server(let status, _): "server \(status)"
        case .offline: "offline"
        case .timedOut: "timedOut"
        case .unreachable: "unreachable"
        case .network: "network"
        case .cutOff: "cutOff"
        case .emptyAnswer: "emptyAnswer"
        }
    }
}

/// Where the log file goes: `quickask-events.log` in the folder given (the app's Caches). The
/// old `quickask.log`, from before lines were redacted, held what was said and spoken: it's
/// deleted the first time the store's used, and at every launch.
nonisolated struct QuickAskLogStore: Sendable {
    static let fileName = "quickask-events.log"
    static let oldFileName = "quickask.log"
    static let limit = 1_000_000

    let directory: URL
    var url: URL { directory.appendingPathComponent(Self.fileName) }

    func removeOldLog() {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(Self.oldFileName))
    }

    /// Only ever a `QuickAskLogMessage` (already redacted) under a category fixed in the code:
    /// no way to hand the file a string of what was said.
    func append(category: StaticString, error: Bool, _ message: QuickAskLogMessage, at stamp: Date) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate, .withTime, .withFractionalSeconds, .withColonSeparatorInTime, .withDashSeparatorInDate]
        let line = "\(category)\(error ? " ERROR" : "") \(message.text)"
        let data = Data("\(formatter.string(from: stamp)) \(line)\n".utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            let size = (try? handle.seekToEnd()) ?? 0
            if size > UInt64(Self.limit) {
                // Keep the newest half.
                try? handle.close()
                if let old = try? Data(contentsOf: url) {
                    try? (old.suffix(Self.limit / 2) + data).write(to: url)
                }
                return
            }
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }
}
