import Foundation
import OSLog

/// Quick ask's log: each line goes to the system log (Console.app, `log stream --predicate
/// 'subsystem == "com.mikecann.threadbear"'`) and is appended straight away to
/// Library/Caches/quickask-events.log, so a hang on a phone can be read off it afterwards with
/// `devicectl device copy from`, even if the app's killed. (Reading the system log back from the
/// app only returns notices and errors, and `log collect` from a phone needs root.) A line is
/// events, counts, timings and error categories only: `QuickAskLogMessage` (QuickAskCore) leaves
/// out anything not marked `.public`, so never mark what was said or spoken, a thread id, a token
/// or an error's description public (`QuickAskLogTests` holds every `.public` to a list).
nonisolated enum Log {
    static let app = QuickAskLogger(category: "quickask")
    static let audio = QuickAskLogger(category: "quickask-audio")
    static let speech = QuickAskLogger(category: "quickask-speech")
    static let net = QuickAskLogger(category: "quickask-net")
    static let timing = QuickAskLogger(category: "quickask-timing")
}

nonisolated struct QuickAskLogger: Sendable {
    let category: StaticString
    private var logger: Logger { Logger(subsystem: "com.mikecann.threadbear", category: "\(category)") }

    init(category: StaticString) { self.category = category }

    // `message.text` is already redacted, so public here leaks nothing private.
    func info(_ message: QuickAskLogMessage) {
        logger.info("\(message.text, privacy: .public)")
        QuickAskLogFile.append(category: category, error: false, message)
    }

    func error(_ message: QuickAskLogMessage) {
        logger.error("\(message.text, privacy: .public)")
        QuickAskLogFile.append(category: category, error: true, message)
    }
}

/// Wall-clock seconds, the one clock every timing uses (so it lines up with the process start time).
nonisolated enum Stopwatch {
    static var now: Double { Date().timeIntervalSince1970 }
}

/// For handing an object that's only ever used safely (by the API's own rules) across a closure
/// boundary Swift can't see into, like a recognition request that's documented as thread-safe.
nonisolated final class UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}

/// True the first time `claim()` is called, false after. For callbacks that fire many times when
/// only the first one matters, from whatever thread.
nonisolated final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.withLock {
            if claimed { return false }
            claimed = true
            return true
        }
    }
}

/// Library/Caches/quickask-events.log: every quick ask log line, time-stamped, appended as it
/// happens, on a queue of its own.
nonisolated enum QuickAskLogFile {
    private static let queue = DispatchQueue(label: "com.mikecann.threadbear.quickask.logfile", qos: .utility)
    private static let store: QuickAskLogStore? = {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else { return nil }
        let store = QuickAskLogStore(directory: caches)
        store.removeOldLog()
        return store
    }()

    /// Deletes the old, unredacted quickask.log. Called at launch, so it goes even if quick ask
    /// is never used again.
    static func removeOldLog() {
        queue.async { _ = store }
    }

    static func append(category: StaticString, error: Bool, _ message: QuickAskLogMessage) {
        let stamp = Date()
        queue.async { store?.append(category: category, error: error, message, at: stamp) }
    }
}
