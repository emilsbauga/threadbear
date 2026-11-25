import Foundation
import os

/// One URLSession for everything, so the connection the ping opens (DNS, TCP, TLS) is the one the
/// question goes out on.
final class AskClient {
    private(set) var session: URLSession
    private var lastPingAt: Double?
    private var lastPingHost: String?

    init() {
        session = Self.makeSession()
    }

    /// Drops the open connection and makes a new one: for a question that's had no reply at
    /// all, as if the connection had died (AnswerStream's retry).
    func freshSession() -> URLSession {
        session.finishTasksAndInvalidate()
        session = Self.makeSession()
        lastPingAt = nil
        return session
    }

    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.default
        // Tells the system this traffic is someone waiting on a reply, not a background download.
        config.networkServiceType = .responsiveData
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }

    /// Opens (or keeps open) the connection ahead of the question. Fire and forget.
    func ping(_ request: URLRequest) {
        lastPingAt = Stopwatch.now
        lastPingHost = request.url?.host()
        let session = session
        Task.detached(priority: .userInitiated) {
            let started = Stopwatch.now
            do {
                let (_, response) = try await session.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                Log.net.info("Ping \(status) in \(Int((Stopwatch.now - started) * 1000)) ms")
            } catch {
                Log.net.error("Ping failed: \(error: error)")
            }
        }
    }

    /// Pings again if it's been a while (servers close idle connections), e.g. when you start talking.
    func pingIfStale(_ request: URLRequest, olderThan seconds: Double = 25) {
        if let lastPingAt, lastPingHost == request.url?.host(), Stopwatch.now - lastPingAt < seconds { return }
        ping(request)
    }
}
