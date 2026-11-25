import AVFoundation
import os

/// Where mic buffers go, called on the audio thread.
typealias AudioSink = @Sendable (AVAudioPCMBuffer) -> Void

/// The mic and the one audio session everything shares.
///
/// The session is set up once as play-and-record to the loud speaker, so going from listening to
/// speaking the answer and back to listening for a follow-up never changes category (which is what
/// costs time and glitches). The engine keeps running between questions while the app's in use;
/// "stopping" listening just stops handing buffers on. `stop()` shuts it all down (backgrounded, or
/// idle for a while) and lets other audio, like a paused podcast, carry on.
///
/// Everything that touches the engine or session runs on one serial queue, off the main thread,
/// because activating a session blocks.
///
/// The mic can be started before anyone's listening (`startEarly`), since getting the session and
/// engine going is what takes the time after the app's been in the background. Until `start` hands
/// over a sink, the last few seconds it hears are kept, then passed on ahead of the live audio, so
/// the first words of a question aren't lost to the start-up.
nonisolated final class AudioInput: @unchecked Sendable {
    struct Handlers {
        var sink: AudioSink?
        var level: (@Sendable (Float, Double) -> Void)?
        var firstBuffer: (@Sendable (Double) -> Void)?
    }

    nonisolated enum Failure: Error, QuickAskLogCategorized {
        case noMicrophone
        /// The audio hardware is between formats (a route or configuration change).
        case formatChanging
        case session(String)
        case engine(String)

        var message: String {
            switch self {
            case .noMicrophone: "There's no microphone available."
            case .formatChanging: "The microphone was busy changing. Tap the mic to try again."
            case .session(let detail): "Couldn't start the audio session: \(detail)"
            case .engine(let detail): "Couldn't start the microphone: \(detail)"
            }
        }

        var logCategory: String {
            switch self {
            case .noMicrophone: "noMicrophone"
            case .formatChanging: "formatChanging"
            case .session: "session"
            case .engine: "engine"
            }
        }
    }

    /// Called (on any thread) when a phone call, Siri or an alarm takes the audio away. Set once, up front.
    var onInterrupted: (@Sendable () -> Void)?

    /// Most of the audio kept while the mic's on with nobody listening yet. Covers the gap
    /// between the app coming forward and listening starting with plenty to spare.
    private static let prerollSeconds: Double = 3

    private let engine = AVAudioEngine()
    private let queue = DispatchQueue(label: "com.mikecann.threadbear.quickask.audio", qos: .userInteractive)
    private let lock = NSLock()
    private var handlers = Handlers() // lock
    private var awaitingFirstBuffer = false // lock
    /// Keeping what the mic hears until `start` claims it, after `startEarly`.
    private var capturingPreroll = false // lock
    private var preroll: [(buffer: AVAudioPCMBuffer, at: Double)] = [] // lock
    /// Claimed pre-roll, passed to the sink on the audio thread ahead of the next live buffer.
    private var replay: [(buffer: AVAudioPCMBuffer, at: Double)] = [] // lock
    /// When the engine last started from stopped, until its first buffer's been logged.
    private var engineStartedAt: Double? // lock
    private var lastEngineStartAt: Double? // queue
    private var configured = false // queue
    private var sessionActive = false // queue
    private var tapInstalled = false // queue
    private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            // A route change (AirPods in or out) stops the engine; start it again if we're listening.
            guard let self else { return }
            queue.async { self.restartAfterConfigurationChange() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
            guard let self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            queue.async { self.sessionActive = false }
            onInterrupted?()
        })
    }

    /// Takes the audio session ahead of speaking, which stops other apps' audio, so it's only for
    /// when the user has asked for sound. Never at launch (see QuickAskModel.prepare).
    func prewarm() {
        queue.async { [self] in
            do {
                try configureIfNeeded()
                try activateIfNeeded()
                _ = engine.inputNode
                engine.prepare()
                Log.audio.info("Prewarmed (session active: \(self.sessionActive))")
            } catch {
                Log.audio.error("Prewarm failed: \(error: error)")
            }
        }
    }

    /// Forgets that the session's active, so the next start activates it again. The system can take
    /// the audio session away between asks (a call, another app), so a quick ask can't trust
    /// `sessionActive`. (The category's checked against the session itself, in
    /// `configureIfNeeded`, rather than set again here: setting it while the engine's going is an
    /// audio configuration change, which restarts the mic.)
    func resetSession() {
        queue.async { [self] in
            guard !engine.isRunning else { return }
            sessionActive = false
        }
    }

    /// Gets the mic going ahead of `start`, keeping what it hears for the sink `start` is given.
    /// If it can't start yet, that's only logged: `start` tries again and reports it.
    func startEarly() {
        let requestedAt = Stopwatch.now
        lock.withLock {
            // Already listening (the engine's warm and someone's taking the buffers): nothing to keep.
            guard handlers.sink == nil, handlers.level == nil else { return }
            if !capturingPreroll { preroll.removeAll() }
            capturingPreroll = true
        }
        queue.async { [self] in
            do {
                try startEngineIfNeeded(requestedAt: requestedAt, early: true)
            } catch let error as Failure {
                Log.audio.error("Early start failed (it'll try again when listening starts): \(error: error)")
            } catch {
                Log.audio.error("Early start failed: \(error: error)")
            }
        }
    }

    /// Starts handing buffers to `sink`, beginning with anything kept since `startEarly`.
    /// `firstBuffer` fires once, when the mic is truly live (the first kept buffer, if any).
    func start(sink: AudioSink?,
               level: @escaping @Sendable (Float, Double) -> Void,
               firstBuffer: @escaping @Sendable (Double) -> Void,
               failure: @escaping @Sendable (Failure) -> Void) {
        let requestedAt = Stopwatch.now
        let kept = lock.withLock { () -> Double in
            handlers = Handlers(sink: sink, level: level, firstBuffer: firstBuffer)
            awaitingFirstBuffer = true
            replay = capturingPreroll ? preroll : []
            preroll.removeAll()
            capturingPreroll = false
            return replay.reduce(0) { $0 + Double($1.buffer.frameLength) / max($1.buffer.format.sampleRate, 1) }
        }
        if kept > 0 { Log.timing.info("Handing over \(Int(kept * 1000)) ms of audio heard before listening started") }
        queue.async { [self] in
            do {
                try startEngineIfNeeded(requestedAt: requestedAt, early: false)
            } catch let error as Failure {
                Log.audio.error("Start failed: \(error: error)")
                failure(error)
            } catch {
                failure(.engine(error.localizedDescription))
            }
        }
    }

    /// Stops handing buffers on, leaving the engine running for a quick follow-up.
    func pause() {
        lock.withLock {
            handlers = Handlers()
            replay.removeAll()
            // Between questions the mic hears the answer being spoken, which mustn't be kept.
            capturingPreroll = false
            preroll.removeAll()
        }
    }

    /// Stops the mic and, if asked, gives the audio session back so other apps' audio resumes.
    func stop(deactivate: Bool) {
        pause()
        queue.async { [self] in
            if engine.isRunning { engine.stop() }
            if tapInstalled {
                engine.inputNode.removeTap(onBus: 0)
                tapInstalled = false
            }
            if deactivate, sessionActive {
                do {
                    try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                } catch {
                    Log.audio.error("Deactivate failed: \(error: error)")
                }
                sessionActive = false
            }
            Log.audio.info("Stopped (deactivated: \(deactivate))")
        }
    }

    // MARK: - On the audio queue

    /// Everything between a stopped mic and a running one, timed step by step for the log, since
    /// which step is slow after the app's been in the background can only be seen on a phone.
    private func startEngineIfNeeded(requestedAt: Double, early: Bool) throws {
        let began = Stopwatch.now
        try configureIfNeeded()
        let configured = Stopwatch.now
        let wasActive = sessionActive
        try activateIfNeeded()
        let activated = Stopwatch.now
        // Activating the session can leave the format settling for a moment (see installTapIfNeeded).
        for attempt in 0... {
            do {
                try installTapIfNeeded()
                break
            } catch Failure.formatChanging where attempt < 10 {
                Thread.sleep(forTimeInterval: 0.05)
            }
        }
        let tapped = Stopwatch.now
        guard !engine.isRunning else { return }
        engine.prepare()
        let prepared = Stopwatch.now
        do { try engine.start() } catch { throw Failure.engine(error.localizedDescription) }
        let started = Stopwatch.now
        lastEngineStartAt = started
        lock.withLock { engineStartedAt = started }
        func ms(_ from: Double, _ to: Double) -> Int { Int((to - from) * 1000) }
        Log.timing.info("Mic start\(early ? " (early)" : "", privacy: .public): queue wait \(ms(requestedAt, began)) ms, category \(ms(began, configured)) ms, session \(wasActive ? "already active" : "\(ms(configured, activated)) ms", privacy: .public), tap \(ms(activated, tapped)) ms, prepare \(ms(tapped, prepared)) ms, engine start \(ms(prepared, started)) ms")
    }

    private func configureIfNeeded() throws {
        let session = AVAudioSession.sharedInstance()
        // Something else can change the category; only then does this one need setting again.
        guard !configured || session.category != .playAndRecord else { return }
        do {
            // Loud speaker rather than the earpiece, and AirPods for both directions when they're in.
            try session.setCategory(.playAndRecord, mode: .default,
                                    options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP])
            // iOS mutes haptics while recording unless told otherwise, and the "mic is live" tap needs them.
            try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
            // Smaller buffers: levels (and so end of speech) update every ~20 ms.
            try? session.setPreferredIOBufferDuration(0.02)
        } catch {
            throw Failure.session(error.localizedDescription)
        }
        configured = true
    }

    private func activateIfNeeded() throws {
        guard !sessionActive else { return }
        let started = Stopwatch.now
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            throw Failure.session(error.localizedDescription)
        }
        sessionActive = true
        Log.audio.info("Session active in \(Int((Stopwatch.now - started) * 1000)) ms")
    }

    private func installTapIfNeeded() throws {
        guard !tapInstalled else { return }
        // MicTap refuses while the format is still settling after a configuration change (it
        // crashed the app on 29 Oct, the first time quick ask listened); the callers try again.
        do {
            try MicTap.install(on: engine.inputNode) { [weak self] buffer, _ in self?.handle(buffer) }
        } catch .noMicrophone {
            throw Failure.noMicrophone
        } catch .formatChanging {
            throw Failure.formatChanging
        }
        tapInstalled = true
    }

    private func restartAfterConfigurationChange(attempt: Int = 0) {
        let listening = lock.withLock { handlers.sink != nil || handlers.level != nil || capturingPreroll }
        // Activating the session can change the hardware format just after the engine's started,
        // which stops it and costs a second start: the log shows whether that's happening.
        let sinceStart = lastEngineStartAt.map { "\(Int((Stopwatch.now - $0) * 1000)) ms after the engine started" } ?? "engine not started yet"
        Log.timing.info("Audio configuration changed, \(sinceStart, privacy: .public) (listening: \(listening))")
        if tapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        guard listening else { return }
        do {
            do {
                try installTapIfNeeded()
            } catch Failure.formatChanging where attempt < 10 {
                // Settles within a few tens of milliseconds; up to a second's tries.
                queue.asyncAfter(deadline: .now() + 0.1) { [self] in
                    if !tapInstalled { restartAfterConfigurationChange(attempt: attempt + 1) }
                }
                return
            }
            engine.prepare()
            try engine.start()
            lastEngineStartAt = Stopwatch.now
            lock.withLock { engineStartedAt = lastEngineStartAt }
        } catch {
            Log.audio.error("Restart after route change failed: \(error: error)")
        }
    }

    // MARK: - On the audio thread

    private func handle(_ buffer: AVAudioPCMBuffer) {
        let now = Stopwatch.now
        let (current, first, replayed, startedAt) = lock.withLock { () -> (Handlers, Bool, [(buffer: AVAudioPCMBuffer, at: Double)], Double?) in
            let startedAt = engineStartedAt
            engineStartedAt = nil
            if handlers.sink == nil, handlers.level == nil {
                if capturingPreroll { keepForLater(buffer, at: now) }
                return (handlers, false, [], startedAt)
            }
            let first = awaitingFirstBuffer && handlers.firstBuffer != nil
            if first { awaitingFirstBuffer = false }
            let replayed = replay
            replay.removeAll()
            return (handlers, first, replayed, startedAt)
        }
        if let startedAt { Log.timing.info("First buffer \(Int((now - startedAt) * 1000)) ms after the engine started") }
        if first { current.firstBuffer?(replayed.first?.at ?? now) }
        for kept in replayed {
            current.sink?(kept.buffer)
            if let level = current.level { level(Self.rmsLevel(of: kept.buffer), kept.at) }
        }
        current.sink?(buffer)
        if let level = current.level { level(Self.rmsLevel(of: buffer), now) }
    }

    /// Holding the lock. Copied, since the engine reuses the buffer once the tap returns.
    private func keepForLater(_ buffer: AVAudioPCMBuffer, at time: Double) {
        guard let copy = buffer.copy() as? AVAudioPCMBuffer else { return }
        preroll.append((copy, time))
        let sampleRate = max(buffer.format.sampleRate, 1)
        var seconds = preroll.reduce(0) { $0 + Double($1.buffer.frameLength) / sampleRate }
        while seconds > Self.prerollSeconds, let oldest = preroll.first {
            seconds -= Double(oldest.buffer.frameLength) / sampleRate
            preroll.removeFirst()
        }
    }

    /// RMS of the first channel in dBFS: 0 is full scale, a quiet room is around -60.
    static func rmsLevel(of buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return -100 }
        let count = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<count { sum += samples[i] * samples[i] }
        let rms = (sum / Float(count)).squareRoot()
        return rms > 0 ? max(20 * log10(rms), -100) : -100
    }
}
