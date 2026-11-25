import AVFoundation
import Speech
import os

/// iOS 26's SpeechAnalyzer with a SpeechTranscriber module, reporting fast volatile results.
///
/// Each question gets its own analyzer (one can't be restarted once finished), but the next one is
/// built and prepared as soon as the last ends, and the model is kept loaded for the life of the
/// process, so `begin` doesn't wait. Until the language's model is installed it reports itself not
/// ready (and starts the download), and Automatic uses SFSpeechRecognizer meanwhile.
@available(iOS 26.0, *)
final class AnalyzerTranscriber: Transcriber {
    enum Readiness: Equatable {
        case checking
        case ready
        case downloading
        case unsupported
    }

    private(set) var readiness: Readiness = .checking
    private var locale: Locale
    /// The next analyzer, being built or ready.
    private var next: Task<PreparedAnalyzer?, Never>?
    private var activeAnalyzer: SpeechAnalyzer?
    private var feeder: AnalyzerFeeder?
    private var work: Task<Void, Never>?
    private var generation = 0

    init(locale: Locale = SpeechLocale.current) {
        self.locale = locale
    }

    var name: String { "SpeechAnalyzer" }

    /// Looks for the model, starting a download if it's missing. Calls `onChange` when that settles.
    func checkAssets(onChange: @escaping () -> Void) {
        Task {
            guard SpeechTranscriber.isAvailable,
                  let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
                readiness = .unsupported
                Log.speech.info("SpeechAnalyzer not available for \(self.locale.identifier, privacy: .public)")
                onChange()
                return
            }
            locale = supported
            let module = Self.makeModule(locale: supported)
            switch await AssetInventory.status(forModules: [module]) {
            case .installed:
                readiness = .ready
            case .unsupported:
                readiness = .unsupported
            case .supported, .downloading:
                readiness = .downloading
                Log.speech.info("Downloading the SpeechAnalyzer model for \(supported.identifier, privacy: .public)")
                do {
                    if let request = try await AssetInventory.assetInstallationRequest(supporting: [module]) {
                        try await request.downloadAndInstall()
                    }
                    readiness = .ready
                } catch {
                    readiness = .unsupported
                    Log.speech.error("Model download failed: \(error: error)")
                }
            @unknown default:
                readiness = .unsupported
            }
            Log.speech.info("SpeechAnalyzer \(supported.identifier, privacy: .public): \(String(describing: self.readiness), privacy: .public)")
            if readiness == .ready { prepare() }
            onChange()
        }
    }

    func prepare() {
        guard readiness == .ready, next == nil else { return }
        let locale = locale
        next = Task { await Self.makeAnalyzer(locale: locale) }
    }

    func begin(onText: @escaping (String) -> Void, onError: @escaping (TranscriberError) -> Void) -> AudioSink {
        end()
        generation += 1
        let current = generation
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let feeder = AnalyzerFeeder(continuation: continuation)
        self.feeder = feeder
        let locale = locale
        let pending = next ?? Task { await Self.makeAnalyzer(locale: locale) }
        next = nil

        work = Task {
            guard let prepared = await pending.value else {
                if generation == current { onError(.unavailable("SpeechAnalyzer couldn't start.")) }
                return
            }
            guard generation == current else {
                await prepared.analyzer.cancelAndFinishNow()
                return
            }
            activeAnalyzer = prepared.analyzer
            feeder.setFormat(prepared.format.value)
            let results = Task {
                var finalized = ""
                do {
                    for try await result in prepared.module.results {
                        guard generation == current else { return }
                        let text = String(result.text.characters)
                        if result.isFinal {
                            finalized = Self.join(finalized, text)
                            onText(finalized)
                        } else {
                            onText(Self.join(finalized, text))
                        }
                    }
                } catch {
                    if generation == current, !(error is CancellationError) { onError(.failed(error.localizedDescription)) }
                }
            }
            do {
                try await prepared.analyzer.start(inputSequence: stream)
            } catch {
                if generation == current { onError(.failed(error.localizedDescription)) }
            }
            _ = results
        }
        return { buffer in feeder.feed(buffer) }
    }

    func end() {
        generation += 1
        feeder?.finish()
        feeder = nil
        work?.cancel()
        work = nil
        if let analyzer = activeAnalyzer {
            Task { await analyzer.cancelAndFinishNow() }
        }
        activeAnalyzer = nil
        prepare()
    }

    // MARK: -

    struct PreparedAnalyzer: Sendable {
        let analyzer: SpeechAnalyzer
        let module: SpeechTranscriber
        let format: UncheckedSendable<AVAudioFormat?>
    }

    nonisolated private static func makeModule(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [],
                          reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
    }

    nonisolated private static func makeAnalyzer(locale: Locale) async -> PreparedAnalyzer? {
        let started = Stopwatch.now
        let module = makeModule(locale: locale)
        let analyzer = SpeechAnalyzer(modules: [module],
                                      options: .init(priority: .userInitiated, modelRetention: .processLifetime))
        let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module])
        do {
            try await analyzer.prepareToAnalyze(in: format)
        } catch {
            Log.speech.error("SpeechAnalyzer prepare failed: \(error: error)")
            return nil
        }
        Log.speech.info("SpeechAnalyzer ready in \(Int((Stopwatch.now - started) * 1000)) ms")
        return PreparedAnalyzer(analyzer: analyzer, module: module, format: UncheckedSendable(format))
    }

    nonisolated private static func join(_ a: String, _ b: String) -> String {
        let a = a.trimmingCharacters(in: .whitespaces)
        let b = b.trimmingCharacters(in: .whitespaces)
        if a.isEmpty { return b }
        if b.isEmpty { return a }
        return a + " " + b
    }
}

/// Converts mic buffers to the analyzer's format and hands them over, on the audio thread. Buffers
/// that arrive before the analyzer is ready wait here rather than being lost.
@available(iOS 26.0, *)
nonisolated final class AnalyzerFeeder: @unchecked Sendable {
    private let lock = NSLock()
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var formatKnown = false
    private var target: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var waiting: [AVAudioPCMBuffer] = []

    init(continuation: AsyncStream<AnalyzerInput>.Continuation) {
        self.continuation = continuation
    }

    func setFormat(_ format: AVAudioFormat?) {
        lock.withLock {
            target = format
            formatKnown = true
            let queued = waiting
            waiting.removeAll()
            for buffer in queued { send(buffer) }
        }
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        lock.withLock {
            if formatKnown {
                send(buffer)
            } else if let copy = buffer.copy() as? AVAudioPCMBuffer {
                waiting.append(copy)
            }
        }
    }

    func finish() {
        continuation.finish()
    }

    /// Holding the lock.
    private func send(_ buffer: AVAudioPCMBuffer) {
        guard let target, target != buffer.format else {
            continuation.yield(AnalyzerInput(buffer: buffer))
            return
        }
        if converter == nil || converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: target)
        }
        guard let converter else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
        // The input block runs synchronously inside convert(to:): hand over this one buffer, then stop.
        let first = OnceFlag()
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            guard first.claim() else {
                status.pointee = .noDataNow
                return nil
            }
            status.pointee = .haveData
            return buffer
        }
        if let error {
            Log.speech.error("Audio conversion failed: \(error: error)")
            return
        }
        if output.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: output)) }
    }
}
