import Foundation
import Observation

/// Where quick asks go and how they sound. The archive server's address is in UserDefaults and
/// its token in the Keychain (this device only), never shown again once saved. With neither set
/// there's no quick ask at all: it's for someone with an Agent Archive server, which on the App
/// Store is nearly no one.
@Observable
final class QuickAskSettings {
    var baseURLString: String { didSet { defaults.set(baseURLString, forKey: Keys.baseURL) } }
    var voiceIdentifier: String? { didSet { defaults.set(voiceIdentifier, forKey: Keys.voice) } }
    var silenceMs: Int { didSet { defaults.set(silenceMs, forKey: Keys.silence) } }
    var speakAnswers: Bool { didSet { defaults.set(speakAnswers, forKey: Keys.speak) } }
    private(set) var token: String?

    static let silenceRange = 300...2000

    @ObservationIgnored private let defaults = UserDefaults.standard

    private enum Keys {
        static let baseURL = "quickAsk.baseURL"
        static let voice = "quickAsk.voice"
        static let silence = "quickAsk.silenceMs"
        static let speak = "quickAsk.speakAnswers"
        static let service = "com.mikecann.threadbear.quickask"
        static let tokenAccount = "archiveToken"
    }

    init() {
        baseURLString = defaults.string(forKey: Keys.baseURL) ?? ""
        voiceIdentifier = defaults.string(forKey: Keys.voice)
        let silence = defaults.integer(forKey: Keys.silence)
        silenceMs = Self.silenceRange.contains(silence) ? silence : 700
        speakAnswers = defaults.object(forKey: Keys.speak) == nil ? true : defaults.bool(forKey: Keys.speak)
        token = Keychain.read(service: Keys.service, account: Keys.tokenAccount)
        #if DEBUG
        // `-QuickAskServer <url> -QuickAskToken <aa_…>` for the simulator, which has no
        // camera to scan a setup code with. Not kept.
        if let server = defaults.string(forKey: "QuickAskServer") { baseURLString = server }
        if let token = defaults.string(forKey: "QuickAskToken") { self.token = token }
        #endif
    }

    var baseURL: URL? { AskAPI.normalizeBaseURL(baseURLString) }
    var hasToken: Bool { !(token ?? "").isEmpty }
    /// Both set, so the screen, the inbox's button and the Action button do something.
    var isReady: Bool { baseURL != nil && hasToken }

    func setToken(_ value: String) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            Keychain.delete(service: Keys.service, account: Keys.tokenAccount)
            token = nil
        } else {
            Keychain.write(trimmed, service: Keys.service, account: Keys.tokenAccount)
            token = trimmed
        }
    }

    func forget() {
        baseURLString = ""
        setToken("")
    }

    /// A token claimed with a setup code (QuickAskSetup), for the server that code named.
    /// The caller asked first, as a code from anyone could otherwise take every later question.
    func apply(_ setup: QuickAskSetup, token: String) {
        baseURLString = setup.server
        setToken(token)
    }
}

/// The last 20 timings, kept between launches, for Settings › Quick ask.
@Observable
final class QuickAskTimings {
    private(set) var log: TimingLog
    @ObservationIgnored private let key = "quickAsk.timings"

    init() {
        log = UserDefaults.standard.data(forKey: key)
            .flatMap { try? JSONDecoder().decode(TimingLog.self, from: $0) } ?? TimingLog()
    }

    func record(_ timing: QuestionTiming) {
        log.record(timing)
        if let data = try? JSONEncoder().encode(log) { UserDefaults.standard.set(data, forKey: key) }
    }
}
