import AVFoundation
import os

/// Speaks the answer a sentence at a time as the sentences arrive, through the app's own audio
/// session (so it's the loud speaker, with no session switch after listening). A server's filler
/// line is cut short once the answer after it is ready (FillerCut decides; this does what it says).
final class Speaker {
    /// The moment the first word of an answer is actually spoken.
    var onFirstWord: ((Double) -> Void)?
    /// Everything queued has been spoken (or stopped).
    var onIdle: (() -> Void)?

    private let synthesizer = AVSpeechSynthesizer()
    private let delegate = SpeechDelegate()
    private var warmer: AVSpeechSynthesizer?
    private var voicePicked = false
    private var warmWanted = false
    private var warmed = false
    private(set) var voice: AVSpeechSynthesisVoice?
    private var plan = FillerCut()
    /// Each utterance given to the synthesizer is one of the plan's numbered sentences.
    private var utterances: [ObjectIdentifier: Int] = [:]
    /// The wait for a cut filler to stop, in case the synthesizer never says it has.
    private var cutWait: Task<Void, Never>?
    /// The word being said, for the log when a filler's cut.
    private var currentWord: String?
    private var firstWordSeen = true
    private var firstStartAt: Double?
    private var spokenCount = 0

    init() {
        delegate.onEvent = { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        synthesizer.delegate = delegate
        synthesizer.usesApplicationAudioSession = true
    }

    /// Also while the answer's sentences are held for a filler that's being cut short.
    var isSpeaking: Bool { !plan.isIdle }

    // MARK: - Voices

    nonisolated static func installedVoices() -> [VoiceInfo] {
        AVSpeechSynthesisVoice.speechVoices().map { voice in
            VoiceInfo(id: voice.identifier, name: voice.name, language: voice.language, quality: voice.quality.rawValue,
                      isNovelty: voice.voiceTraits.contains(.isNoveltyVoice),
                      isPersonal: voice.voiceTraits.contains(.isPersonalVoice))
        }
    }

    /// The chosen voice if it's still installed, else the best installed English voice (premium,
    /// then enhanced, then default; Australian or British first within each). Listing voices can
    /// take a while the first time, so this is kept off the main thread at launch.
    nonisolated static func resolveVoice(preferred id: String?) -> String? {
        if let id, AVSpeechSynthesisVoice(identifier: id) != nil { return id }
        return VoiceRanking.best(installedVoices())?.id ?? AVSpeechSynthesisVoice(language: "en-GB")?.identifier
    }

    /// Picks the voice now (for Settings, where a short wait doesn't matter).
    func selectVoice(id: String?) {
        useVoice(id: Self.resolveVoice(preferred: id))
    }

    /// Picks the voice in the background. Loading it is `warmUpVoice`, as rendering speech at
    /// launch is suspected of stopping other apps' audio (see QuickAskModel.prepare).
    func selectVoiceInBackground(id: String?) {
        Task.detached(priority: .userInitiated) {
            let resolved = Self.resolveVoice(preferred: id)
            await MainActor.run {
                self.useVoice(id: resolved)
            }
        }
    }

    private func useVoice(id: String?) {
        let chosen = id.flatMap(AVSpeechSynthesisVoice.init(identifier:))
        voice = chosen
        voicePicked = true
        if warmWanted { warmUpVoice() }
        Log.speech.info("Voice: \(chosen?.name ?? "system", privacy: .public) \(chosen?.language ?? "", privacy: .public) quality \(chosen?.quality.rawValue ?? 0)")
    }

    /// Loads the voice once so the first answer doesn't wait on it, as soon as the voice is picked
    /// (the Action button can get here first, on a cold launch).
    func warmUpVoice() {
        guard !warmed else { return }
        guard voicePicked else {
            warmWanted = true
            return
        }
        warmed = true
        warmWanted = false
        warmUp()
    }

    /// Renders a word offline (no sound) so the voice is loaded before the first real answer.
    private func warmUp() {
        let warmer = AVSpeechSynthesizer()
        self.warmer = warmer
        let utterance = AVSpeechUtterance(string: "Okay.")
        utterance.voice = voice
        Self.render(utterance, with: warmer)
        Task {
            try? await Task.sleep(for: .seconds(5))
            self.warmer = nil
        }
    }

    /// The buffer callback comes on a background queue, so it's made outside the main actor.
    nonisolated private static func render(_ utterance: AVSpeechUtterance, with synthesizer: AVSpeechSynthesizer) {
        let started = Stopwatch.now
        let first = OnceFlag()
        synthesizer.write(utterance) { _ in
            if first.claim() { Log.speech.info("Voice warmed up in \(Int((Stopwatch.now - started) * 1000)) ms") }
        }
    }

    // MARK: - Speaking

    /// Call before the first sentence of each answer.
    func beginAnswer() {
        stop()
        firstWordSeen = false
        firstStartAt = nil
        spokenCount = 0
    }

    func speak(_ text: String) {
        run(plan.sentence(text, at: Stopwatch.now))
    }

    /// A stage line arrived: what's said from now on is the answer, and the filler before it can
    /// be cut short when the answer's ready.
    func stageBegan() {
        plan.stageBegan()
    }

    func stop() {
        let wasSpeaking = isSpeaking
        plan.reset()
        utterances.removeAll()
        cutWait?.cancel()
        cutWait = nil
        currentWord = nil
        if synthesizer.isSpeaking || synthesizer.isPaused { synthesizer.stopSpeaking(at: .immediate) }
        if wasSpeaking { onIdle?() }
    }

    private func run(_ steps: [FillerCut.Step]) {
        for step in steps {
            switch step {
            case .speak(let id, let text):
                enqueue(id, text)
            case .stop(let boundary):
                synthesizer.stopSpeaking(at: boundary == .word ? .word : .immediate)
                if let cut = plan.cut, !cut.timedOut { logCut(cut) }
            case .waitAtMost(let seconds):
                cutWait?.cancel()
                cutWait = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(seconds))
                    guard !Task.isCancelled, let self else { return }
                    self.run(self.plan.waitRanOut(at: Stopwatch.now))
                }
            case .stopped:
                cutWait?.cancel()
                cutWait = nil
                if let cut = plan.cut { logStopped(cut) }
            }
        }
    }

    private func enqueue(_ id: Int, _ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.preUtteranceDelay = 0
        utterance.postUtteranceDelay = 0
        utterances[ObjectIdentifier(utterance)] = id
        spokenCount += 1
        Log.speech.info("Queued sentence \(self.spokenCount) (\(text.count) characters)")
        synthesizer.speak(utterance)
    }

    /// For tuning from a phone's logs: how far into the filler the answer was ready, and how long
    /// the stop took to land.
    private func logCut(_ cut: FillerCut.Cut) {
        let word = currentWord == nil ? "its first word" : "its current word"
        let when = cut.spokenFor.map { "\(Int($0 * 1000)) ms into it" } ?? "before it started"
        Log.speech.info("Cutting the filler at the end of \(word, privacy: .public): the answer's ready \(when, privacy: .public)")
    }

    private func logStopped(_ cut: FillerCut.Cut) {
        let after = Int(((cut.stoppedAt ?? cut.at) - cut.at) * 1000)
        let how = switch (cut.timedOut, cut.stillSpeaking) {
        case (true, true): "said it had stopped but the synthesizer kept speaking, so it was stopped straight away; going on \(after) ms after the cut"
        case (true, false): "never said it had stopped, so it was stopped straight away; going on \(after) ms after the cut"
        case (false, true): "stopped \(after) ms after the cut, once its next sentence had stopped too"
        case (false, false): "stopped \(after) ms after the cut"
        }
        let waited = cut.released == 1 ? "the sentence that waited" : "the \(cut.released) sentences that waited"
        Log.speech.info("Filler \(how, privacy: .public); speaking \(waited, privacy: .public)")
    }

    // MARK: - Synthesizer events

    private func handle(_ event: SpeechDelegate.Event) {
        switch event {
        case .started(let id, let time): started(id, at: time)
        case .word(let id, let word, let time): wordStarted(id, word, at: time)
        case .finished(let id): finished(id)
        }
    }

    private func started(_ utterance: ObjectIdentifier, at time: Double) {
        guard let id = utterances[utterance] else { return }
        plan.started(id, at: time)
        if firstStartAt == nil { firstStartAt = time }
    }

    private func wordStarted(_ utterance: ObjectIdentifier, _ word: String, at time: Double) {
        guard utterances[utterance] != nil else { return }
        currentWord = word
        guard !firstWordSeen else { return }
        firstWordSeen = true
        onFirstWord?(time)
    }

    private func finished(_ utterance: ObjectIdentifier) {
        guard let id = utterances.removeValue(forKey: utterance) else { return }
        // Some voices never report word ranges; then the start of the first sentence will do.
        if !firstWordSeen, let firstStartAt {
            firstWordSeen = true
            onFirstWord?(firstStartAt)
        }
        let wasSpeaking = isSpeaking
        // Releases the answer's held sentences if this was the filler stopping, before anything
        // can look idle.
        run(plan.finished(id, quiet: !synthesizer.isSpeaking, at: Stopwatch.now))
        if wasSpeaking, !isSpeaking { onIdle?() }
    }
}

/// The synthesizer's delegate calls aren't guaranteed to be on the main thread, so they land here
/// first, stamped with the time they happened, and are passed on to the main actor.
nonisolated final class SpeechDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    enum Event: Sendable {
        case started(ObjectIdentifier, Double)
        case word(ObjectIdentifier, String, Double)
        case finished(ObjectIdentifier)
    }

    /// Set once, before the synthesizer is used.
    var onEvent: (@Sendable (Event) -> Void)?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        onEvent?(.started(ObjectIdentifier(utterance), Stopwatch.now))
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, willSpeakRangeOfSpeechString characterRange: NSRange,
                           utterance: AVSpeechUtterance) {
        let text = utterance.speechString as NSString
        let word = NSMaxRange(characterRange) <= text.length ? text.substring(with: characterRange) : ""
        onEvent?(.word(ObjectIdentifier(utterance), word, Stopwatch.now))
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onEvent?(.finished(ObjectIdentifier(utterance)))
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onEvent?(.finished(ObjectIdentifier(utterance)))
    }
}
