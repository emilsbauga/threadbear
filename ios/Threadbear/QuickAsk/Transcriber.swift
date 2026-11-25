import AVFoundation
import Speech

nonisolated enum TranscriberError: Error, Equatable {
    case unavailable(String)
    case failed(String)

    var message: String {
        switch self {
        case .unavailable(let detail): "\(detail) Tap the mic to try again."
        case .failed(let detail): "Speech recognition stopped (\(detail)). Tap the mic to try again."
        }
    }
}

extension TranscriberError: QuickAskLogCategorized {
    nonisolated var logCategory: String {
        switch self {
        case .unavailable: "unavailable"
        case .failed: "failed"
        }
    }
}

/// Turns mic audio into a live transcript, one question at a time.
protocol Transcriber: AnyObject {
    /// Shown with each timing so different engines can be compared.
    var name: String { get }
    /// Work done ahead of the next question, so `begin` is instant. Safe to call repeatedly.
    func prepare()
    /// Starts a fresh transcript. `onText` gets the whole transcript so far, every time it changes.
    /// Returns where the mic's buffers should go (called on the audio thread).
    func begin(onText: @escaping (String) -> Void, onError: @escaping (TranscriberError) -> Void) -> AudioSink
    /// Stops listening. No callbacks after this.
    func end()
}

/// The language to listen in: the phone's, if it's English, else British English.
nonisolated enum SpeechLocale {
    static var current: Locale {
        let locale = Locale.current
        return locale.language.languageCode?.identifier == "en" ? locale : Locale(identifier: "en-GB")
    }
}

/// Mic and speech-recognition permission.
enum Permissions {
    enum State: Equatable {
        case granted
        case undetermined
        case denied
    }

    static var state: State {
        let mic = AVAudioApplication.shared.recordPermission
        let speech = SFSpeechRecognizer.authorizationStatus()
        if mic == .denied || speech == .denied || speech == .restricted { return .denied }
        if mic == .granted, speech == .authorized { return .granted }
        return .undetermined
    }

    static var micGranted: Bool { AVAudioApplication.shared.recordPermission == .granted }

    /// Asks for whichever hasn't been answered yet.
    static func request() async -> State {
        if AVAudioApplication.shared.recordPermission == .undetermined {
            _ = await AVAudioApplication.requestRecordPermission()
        }
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            _ = await requestSpeech()
        }
        return state
    }

    /// The handler isn't called on the main queue, so the closure mustn't be main-actor isolated.
    nonisolated private static func requestSpeech() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }
}
