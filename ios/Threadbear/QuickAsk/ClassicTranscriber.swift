import AVFoundation
import Speech
import os

/// SFSpeechRecognizer, on device where the language supports it (it does for English on any
/// recent iPhone), streaming partial results. Works on iOS 18 and 26.
final class ClassicTranscriber: Transcriber {
    private let recognizer: SFSpeechRecognizer?
    private var task: SFSpeechRecognitionTask?
    /// Where the mic's buffers go. A holder rather than the request itself, so the request can be
    /// swapped for a server one mid-question without the audio side noticing.
    private var target: RequestTarget?
    /// Bumped on every begin and end, so a late result from an old question is ignored.
    private var generation = 0
    /// Set when the on-device model wouldn't start (the simulator, or a phone whose model is
    /// missing). From then on this run uses Apple's servers rather than not working at all.
    private var onDeviceBroken = false

    init(locale: Locale = SpeechLocale.current) {
        recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-GB"))
        recognizer?.defaultTaskHint = .dictation
        let onDevice = recognizer?.supportsOnDeviceRecognition ?? false
        Log.speech.info("SFSpeechRecognizer \(locale.identifier, privacy: .public), on device: \(onDevice)")
    }

    var name: String { usesOnDevice ? "SFSpeechRecognizer" : "SFSpeechRecognizer (server)" }

    private var usesOnDevice: Bool { (recognizer?.supportsOnDeviceRecognition ?? false) && !onDeviceBroken }

    /// Whether the next question's audio stays on the phone. When it's false (no on-device model for
    /// the language, or it wouldn't start this run) iOS sends the audio to Apple's speech
    /// recognition while you talk, the same as dictation. That's the only time any audio leaves the
    /// phone.
    var runsOnDevice: Bool { usesOnDevice }

    func prepare() {}

    func begin(onText: @escaping (String) -> Void, onError: @escaping (TranscriberError) -> Void) -> AudioSink {
        end()
        guard let recognizer, recognizer.isAvailable else {
            onError(.unavailable("Speech recognition isn't available right now."))
            return { _ in }
        }
        generation += 1
        let target = RequestTarget()
        self.target = target
        startTask(recognizer, target: target, generation: generation, onText: onText, onError: onError)
        return { buffer in target.append(buffer) }
    }

    func end() {
        generation += 1
        target?.finish()
        task?.cancel()
        target = nil
        task = nil
    }

    private func startTask(_ recognizer: SFSpeechRecognizer, target: RequestTarget, generation current: Int,
                           onText: @escaping (String) -> Void, onError: @escaping (TranscriberError) -> Void) {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // On device is quicker (no round trip) and private. Apple's servers only if there's no
        // on-device model for this language, or it wouldn't start.
        request.requiresOnDeviceRecognition = usesOnDevice
        if !usesOnDevice { Log.speech.info("Speech recognition is using Apple's servers for this question: the audio goes to Apple") }
        request.addsPunctuation = true
        request.taskHint = .dictation
        target.replace(with: request)
        // The recogniser calls back on its queue, which is the main queue.
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self, self.generation == current else { return }
            if let result { onText(result.bestTranscription.formattedString) }
            guard let error = error as NSError?, !Self.isBenign(error) else { return }
            if request.requiresOnDeviceRecognition, Self.isOnDeviceStartFailure(error) {
                Log.speech.error("On-device recognition wouldn't start (\(error.code)); using the server")
                onDeviceBroken = true
                startTask(recognizer, target: target, generation: current, onText: onText, onError: onError)
                return
            }
            Log.speech.error("Recognition error \(error.domain, privacy: .public) \(error.code)")
            onError(.failed(error.localizedDescription))
        }
    }

    /// "No speech detected" and cancellation aren't worth showing; the listening timeout covers them.
    private static func isBenign(_ error: NSError) -> Bool {
        error.domain == "kAFAssistantErrorDomain" && [203, 209, 216, 301, 1110].contains(error.code)
    }

    /// "Failed to initialize recognizer" and friends: the on-device model isn't there.
    private static func isOnDeviceStartFailure(_ error: NSError) -> Bool {
        error.domain == "kLSRErrorDomain" && [100, 101, 102, 300].contains(error.code)
    }
}

/// The current recognition request, fed from the audio thread. `append` on a request is
/// thread-safe; swapping which request gets the buffers is guarded here.
nonisolated private final class RequestTarget: @unchecked Sendable {
    private let lock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    /// The first couple of seconds of audio, so a replacement request starts with what was
    /// already said. (The on-device model fails within milliseconds if it's going to.)
    private var opening: [AVAudioPCMBuffer] = []

    func replace(with next: SFSpeechAudioBufferRecognitionRequest) {
        lock.withLock {
            request?.endAudio()
            for buffer in opening { next.append(buffer) }
            request = next
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            // Copied, since the engine may reuse the buffer once the tap returns.
            if opening.count < 100, let copy = buffer.copy() as? AVAudioPCMBuffer { opening.append(copy) }
            request?.append(buffer)
        }
    }

    func finish() {
        lock.withLock {
            request?.endAudio()
            request = nil
            opening.removeAll()
        }
    }
}
