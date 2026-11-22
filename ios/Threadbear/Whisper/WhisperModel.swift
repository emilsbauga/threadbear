import CryptoKit
import Foundation
import Observation
import os

/// Which engine the new-thread mic uses. Unset until the first tap, which
/// asks (Mike, 6 Nov): Whisper is far better at his short dictations than
/// Apple's, but it's a 2 GB download, which shouldn't happen unasked.
enum DictationEngine: String, CaseIterable {
    case apple, whisper

    static let key = "dictation.engine"

    static var chosen: DictationEngine? {
        get { UserDefaults.standard.string(forKey: key).flatMap(DictationEngine.init) }
        set { UserDefaults.standard.set(newValue?.rawValue, forKey: key) }
    }

    var label: String {
        switch self {
        case .apple: "Apple"
        case .whisper: "Whisper"
        }
    }
}

/// Whisper large-v3-turbo (q8_0), from Hugging Face at a pinned commit: the
/// same file Voice Type runs on the Mac, from the same place the Voice Type
/// iPhone keyboard fetched it. Then its Core ML encoder, which whisper.cpp
/// finds beside the weights and runs on the Neural Engine: on the 15 Pro Max
/// that took a dictation from about 2.6 s to 1.0 s (Mike, 22 Nov, after the
/// GPU alone felt slow). The weights alone work while the encoder's coming.
///
/// Background downloads, so they carry on with the app closed.
@MainActor @Observable
final class WhisperModel: NSObject {
    static let shared = WhisperModel()

    nonisolated private static let base = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/"

    nonisolated struct File: Sendable {
        let remote: String
        let sha256: String
        let bytes: Int64
    }

    nonisolated static let weights = File(remote: "ggml-large-v3-turbo-q8_0.bin",
                                          sha256: "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1", bytes: 874_188_075)
    nonisolated static let encoder = File(remote: "ggml-large-v3-turbo-encoder.mlmodelc.zip",
                                          sha256: "84bedfe895bd7b5de6e8e89a0803dfc5addf8c0c5bc4c937451716bf7cf7988a", bytes: 1_173_393_014)
    static let sizeText = "2 GB"
    static let encoderSizeText = "1.2 GB"
    nonisolated static let sessionId = "com.mikecann.threadbear.whisper"

    /// Application Support, not Documents, so it isn't in the Files app, and
    /// left out of iCloud backups since it can always be fetched again.
    nonisolated static var folder: URL { URL.applicationSupportDirectory.appendingPathComponent("Whisper") }
    nonisolated static var fileURL: URL { folder.appendingPathComponent(weights.remote) }
    /// whisper.cpp looks for this name beside the weights, with the "-q8_0" dropped.
    nonisolated static var encoderURL: URL { folder.appendingPathComponent("ggml-large-v3-turbo-encoder.mlmodelc") }

    /// The weights are here, so Whisper can dictate.
    private(set) var installed = FileManager.default.fileExists(atPath: WhisperModel.fileURL.path)
    /// And the encoder, so it's the fast kind.
    private(set) var encoderInstalled = FileManager.default.fileExists(atPath: WhisperModel.encoderURL.path)
    var complete: Bool { installed && encoderInstalled }
    /// 0 to 1 while downloading, nil otherwise.
    private(set) var progress: Double?
    private(set) var problem: String?
    @ObservationIgnored var backgroundCompletion: (() -> Void)?
    @ObservationIgnored private var received: [String: Int64] = [:]

    private let log = Logger(subsystem: "com.mikecann.threadbear", category: "whisper")
    @ObservationIgnored private lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionId)
        // Asked for with the size in front of him, so mobile data is fine;
        // the system still holds it for wifi in Low Data Mode.
        config.allowsConstrainedNetworkAccess = false
        config.sessionSendsLaunchEvents = true
        return URLSession(configuration: config, delegate: Delegate(), delegateQueue: nil)
    }()

    /// Starts whichever file is missing, or picks up downloads already going.
    /// `overCellular` false waits for wifi: for the encoder fetched unasked.
    func download(overCellular: Bool = true) {
        guard !complete else { return }
        problem = nil
        if progress == nil { progress = currentProgress }
        let session = session
        let wantWeights = !installed, wantEncoder = !encoderInstalled
        session.getAllTasks { tasks in
            let running = Set(tasks.compactMap(\.taskDescription))
            for (file, wanted) in [(Self.weights, wantWeights), (Self.encoder, wantEncoder)] where wanted && !running.contains(file.remote) {
                var request = URLRequest(url: URL(string: Self.base + file.remote)!)
                request.allowsCellularAccess = overCellular
                let task = session.downloadTask(with: request)
                task.taskDescription = file.remote
                task.resume()
            }
        }
    }

    /// At launch: hears about a download that went on while the app was
    /// closed, and fetches the encoder for a phone that has only the weights
    /// (everyone who set Whisper up before 22 Nov), on wifi only, as nobody
    /// asked for these 1.2 GB.
    func reconnect() {
        guard DictationEngine.chosen == .whisper, !complete else { return }
        if installed { download(overCellular: false) } else { _ = session }
    }

    func delete() {
        try? FileManager.default.removeItem(at: Self.fileURL)
        try? FileManager.default.removeItem(at: Self.encoderURL)
        refresh()
    }

    /// whisper.cpp wouldn't load the encoder: drop it, so the GPU does the work.
    nonisolated static func dropEncoder() {
        try? FileManager.default.removeItem(at: encoderURL)
        Task { @MainActor in shared.refresh() }
    }

    private func refresh() {
        installed = FileManager.default.fileExists(atPath: Self.fileURL.path)
        encoderInstalled = FileManager.default.fileExists(atPath: Self.encoderURL.path)
    }

    private var currentProgress: Double {
        let done = (installed ? Self.weights.bytes : 0) + (encoderInstalled ? Self.encoder.bytes : 0)
        return min(Double(done + received.values.reduce(0, +)) / Double(Self.weights.bytes + Self.encoder.bytes), 1)
    }

    fileprivate func received(_ written: Int64, for name: String) {
        received[name] = written
        progress = currentProgress
    }

    fileprivate func finished(_ name: String, _ error: String?) {
        received[name] = nil
        refresh()
        if let error {
            problem = error
            log.error("Whisper download \(name, privacy: .public): \(error, privacy: .public)")
        }
        if complete || error != nil { progress = nil }
    }

    fileprivate func eventsDone() {
        backgroundCompletion?()
        backgroundCompletion = nil
    }

    /// The download's callbacks come on URLSession's own queue.
    private final class Delegate: NSObject, URLSessionDownloadDelegate {
        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
                        totalBytesWritten written: Int64, totalBytesExpectedToWrite _: Int64) {
            let name = downloadTask.taskDescription ?? WhisperModel.weights.remote
            Task { @MainActor in WhisperModel.shared.received(written, for: name) }
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
            // The file is gone once this returns, so it's checked and moved here.
            // A task from before 22 Nov has no description: it was the weights.
            let name = downloadTask.taskDescription ?? WhisperModel.weights.remote
            let file = name == WhisperModel.encoder.remote ? WhisperModel.encoder : WhisperModel.weights
            var problem: String?
            do {
                guard try Self.sha256(of: location) == file.sha256 else { throw CocoaError(.fileReadCorruptFile) }
                var folder = WhisperModel.folder
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? folder.setResourceValues(values)
                if file.remote == WhisperModel.weights.remote {
                    try? FileManager.default.removeItem(at: WhisperModel.fileURL)
                    try FileManager.default.moveItem(at: location, to: WhisperModel.fileURL)
                } else {
                    // Unpacked aside and moved in whole: a half-unpacked encoder
                    // beside the weights would stop Whisper loading at all.
                    let unpacking = folder.appendingPathComponent("unpacking")
                    try? FileManager.default.removeItem(at: unpacking)
                    defer { try? FileManager.default.removeItem(at: unpacking) }
                    try MiniUnzip.extract(location, to: unpacking)
                    let unpacked = unpacking.appendingPathComponent(WhisperModel.encoderURL.lastPathComponent)
                    guard FileManager.default.fileExists(atPath: unpacked.appendingPathComponent("weights/weight.bin").path) else {
                        throw CocoaError(.fileReadCorruptFile)
                    }
                    try? FileManager.default.removeItem(at: WhisperModel.encoderURL)
                    try FileManager.default.moveItem(at: unpacked, to: WhisperModel.encoderURL)
                }
            } catch {
                problem = error.localizedDescription
            }
            Task { @MainActor in WhisperModel.shared.finished(name, problem) }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            guard let error else { return }
            let name = task.taskDescription ?? WhisperModel.weights.remote
            Task { @MainActor in WhisperModel.shared.finished(name, error.localizedDescription) }
        }

        func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
            Task { @MainActor in WhisperModel.shared.eventsDone() }
        }

        private static func sha256(of url: URL) throws -> String {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hash = SHA256()
            while let data = try handle.read(upToCount: 1 << 20), !data.isEmpty { hash.update(data: data) }
            return hash.finalize().map { String(format: "%02x", $0) }.joined()
        }
    }
}
