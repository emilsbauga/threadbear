import Foundation
import os

/// One question's answer, read as it streams in from the archive server's `/api/quick/ask`.
///
/// It can go out before it's certain the question's finished (see `EarlySend`), so until something's
/// attached, whatever arrives is kept, and handed over in order the moment it is. That way an
/// answer that's started arriving during the pause isn't lost, just held back.
final class AnswerStream {
    enum Event {
        /// The status and headers arrived, whatever the status.
        case responded(sentAt: Double, at: Double)
        /// A 200's headers.
        case headers(sources: [AnswerSource], serverTiming: [ServerTimingEntry])
        case firstByte(at: Double)
        case text(String)
        case stage(AnswerStage)
        case stageText(AnswerStage, at: Double)
        case sources([AnswerSource])
        case finished(at: Double)
        /// No answer this time (nothing of one had arrived).
        case failed(AskFailure)
        /// The connection went after some of the answer had arrived.
        case cutOff
    }

    let question: String
    let history: [Exchange]
    /// When it was decided to send it: the pause (short or full) or the tap.
    let decidedAt: Double
    /// It failed or was cut off, so it's no use for an answer.
    private(set) var hasFailed = false

    private let request: URLRequest
    private let session: URLSession
    private var kept: [Event] = []
    private var handler: ((Event) -> Void)?
    private var opening: Task<Opened, any Error>?
    private var reading: Task<Void, Never>?
    private var dataTask: URLSessionDataTask?
    private var cancelled = false
    private var watchdog: Task<Void, Never>?
    private var deadline: ServerStreamDeadline?
    private var receivedServerText = false
    /// The status and headers have come back.
    private var responded = false
    private var retried = false
    /// A new connection, for sending it again if it stalls before any reply (see
    /// `ServerStreamDeadline.headersWithin`). Without it there's no retry.
    var freshSession: (() -> URLSession)?

    init(request: URLRequest, question: String, history: [Exchange], decidedAt: Double, session: URLSession) {
        self.request = request
        self.session = session
        self.question = question
        self.history = history
        self.decidedAt = decidedAt
    }

    /// Sends it.
    func start() {
        deadline = ServerStreamDeadline(startedAt: Stopwatch.now)
        send(on: session)
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled, let self else { return }
                let now = Stopwatch.now
                if self.deadline?.stalledBeforeHeaders(at: now, responded: self.responded) == true,
                   !self.retried, let fresh = self.freshSession {
                    // Nothing back at all: the connection's dead. Send it again on a new one.
                    self.retried = true
                    Log.net.error("No reply in \(Int(ServerStreamDeadline.headersWithin)) s; sending again on a new connection")
                    self.opening?.cancel()
                    self.reading?.cancel()
                    self.deadline = ServerStreamDeadline(startedAt: now)
                    self.send(on: fresh())
                    continue
                }
                if self.deadline?.expired(at: Stopwatch.now) == true {
                    self.opening?.cancel()
                    self.dataTask?.cancel()
                    self.reading?.cancel()
                    self.emit(self.receivedServerText ? .cutOff : .failed(.timedOut))
                    return
                }
            }
        }
    }

    /// The request goes out from a detached task straight away, rather than after the main
    /// actor has finished redrawing; the answer's then read on the main actor.
    private func send(on session: URLSession) {
        let request = request
        let opening = Task.detached(priority: .userInitiated) {
            let sentAt = Stopwatch.now
            let (bytes, response) = try await session.bytes(for: request)
            return Opened(sentAt: sentAt, bytes: UncheckedSendable(bytes), response: response)
        }
        self.opening = opening
        reading = Task { await read(opening) }
    }

    /// Hands over everything kept so far, then each event as it happens.
    func attach(_ handler: @escaping (Event) -> Void) {
        self.handler = handler
        while !kept.isEmpty, !cancelled {
            handler(kept.removeFirst())
        }
    }

    /// Drops it. No events after this.
    func cancel() {
        cancelled = true
        watchdog?.cancel()
        handler = nil
        kept.removeAll()
        opening?.cancel()
        dataTask?.cancel()
        reading?.cancel()
    }

    // MARK: -

    /// What `bytes(for:)` handed back, carried from the detached task to the main actor.
    private struct Opened: Sendable {
        let sentAt: Double
        let bytes: UncheckedSendable<URLSession.AsyncBytes>
        let response: URLResponse
    }

    private func emit(_ event: Event) {
        guard !cancelled else { return }
        switch event {
        case .failed, .cutOff: hasFailed = true
        default: break
        }
        if let handler { handler(event) } else { kept.append(event) }
    }

    private func read(_ opening: Task<Opened, any Error>) async {
        defer { watchdog?.cancel() }
        var receivedText = false
        do {
            let opened = try await opening.value
            // Dropped while its headers were on the way.
            if Task.isCancelled || cancelled {
                opened.bytes.value.task.cancel()
                return
            }
            let bytes = opened.bytes.value
            dataTask = bytes.task
            responded = true
            emit(.responded(sentAt: opened.sentAt, at: Stopwatch.now))
            guard let http = opened.response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            guard http.statusCode == 200 else {
                var data = Data()
                for try await byte in bytes {
                    data.append(byte)
                    if data.count > 16_384 { break }
                }
                Log.net.error("Ask failed with \(http.statusCode)")
                return emit(.failed(AskFailure.from(status: http.statusCode, body: data)))
            }
            emit(.headers(
                sources: SourcesHeader.decode(http.value(forHTTPHeaderField: SourcesHeader.name)),
                serverTiming: ServerTiming.ours(ServerTiming.parse(http.value(forHTTPHeaderField: ServerTiming.headerName)))
            ))

            // Complete NDJSON lines go straight into the same text/sentence path as before.
            // Plain text still decodes each byte immediately, with no line buffering.
            var decoder = ServerAnswerDecoder(contentType: http.value(forHTTPHeaderField: "Content-Type"))
            var first = true
            var waiting: AnswerStage?
            for try await byte in bytes {
                guard !Task.isCancelled, !cancelled else { return }
                let now = Stopwatch.now
                if !decoder.isNDJSON || byte == 0x0A { deadline?.received(at: now) }
                if first && !decoder.isNDJSON {
                    first = false
                    emit(.firstByte(at: now))
                }
                guard let event = decoder.push(byte: byte) else { continue }
                switch event {
                case .text(let text):
                    guard !text.isEmpty else { continue }
                    if first {
                        first = false
                        emit(.firstByte(at: now))
                    }
                    if let stage = waiting {
                        emit(.stageText(stage, at: now))
                        waiting = nil
                    }
                    receivedText = true
                    receivedServerText = true
                    emit(.text(text))
                case .stage(let stage):
                    deadline?.received(at: now, stage: true)
                    waiting = stage
                    emit(.stage(stage))
                case .sources(let sources): emit(.sources(sources))
                case .ping: break
                case .done:
                    // done is terminal. Close our side too if a server forgets to end the body.
                    dataTask?.cancel()
                    emit(.finished(at: now))
                    return
                }
            }
            if case .text(let rest) = decoder.finish() { emit(.text(rest)) }
            if decoder.wasCutOff {
                emit(receivedText ? .cutOff : .failed(.cutOff))
            } else {
                emit(.finished(at: Stopwatch.now))
            }
        } catch is CancellationError {
            return
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch let error as URLError {
            Log.net.error("Ask failed: \(error: error)")
            emit(receivedText ? .cutOff : .failed(AskFailure.from(error)))
        } catch {
            emit(receivedText ? .cutOff : .failed(.network(error.localizedDescription)))
        }
    }
}
