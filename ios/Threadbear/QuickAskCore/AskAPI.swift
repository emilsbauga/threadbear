import Foundation

/// A question and its answer, sent back as `history` so follow-ups make sense.
nonisolated struct Exchange: Codable, Equatable, Hashable, Sendable {
    var question: String
    var answer: String
}

/// The JSON body of `POST /api/quick/ask`.
nonisolated struct AskBody: Codable, Equatable, Sendable {
    var question: String
    /// Oldest first, at most three. Left out when empty.
    var history: [Exchange]?
    /// IANA, e.g. Australia/Perth
    var timezone: String
    /// ISO 8601 with the phone's UTC offset, e.g. 2026-10-23T14:06:00+08:00
    var clientTime: String
}

/// Everything about talking to the server that doesn't need a network: building requests and
/// turning failures into plain words. The contract is docs/ask-server.md.
nonisolated enum AskAPI {
    static let pingPath = "/api/quick/ping"
    static let askPath = "/api/quick/ask"
    static let claimPath = "/api/quick/claim"
    static let historyLimit = 3

    static func body(question: String, history: [Exchange], timeZone: TimeZone, now: Date) -> AskBody {
        let recent = recentHistory(history)
        return AskBody(
            question: question.trimmingCharacters(in: .whitespacesAndNewlines),
            history: recent.isEmpty ? nil : recent,
            timezone: timeZone.identifier,
            clientTime: isoTime(now, in: timeZone)
        )
    }

    /// The last three exchanges that have both a question and an answer, oldest first. Both answer
    /// sources send the same history.
    static func recentHistory(_ history: [Exchange]) -> [Exchange] {
        let usable = history.filter {
            !$0.question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !$0.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return Array(usable.suffix(historyLimit))
    }

    static func encode(_ body: AskBody) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(body)
    }

    static func askRequest(baseURL: URL, token: String, body: AskBody) throws -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: askPath))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        request.httpBody = try encode(body)
        // The stream watchdog retains the 30 s initial wait, then 15 s between stage lines.
        // URLSession must allow the silent deep wait; its request limit can't change mid-body.
        request.timeoutInterval = 75
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    static func pingRequest(baseURL: URL) -> URLRequest {
        var request = URLRequest(url: baseURL.appending(path: pingPath))
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    static func isoTime(_ date: Date, in timeZone: TimeZone) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = timeZone
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    /// Accepts what someone might type: no scheme, a trailing slash, stray spaces.
    static func normalizeBaseURL(_ string: String) -> URL? {
        var trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard !trimmed.isEmpty else { return nil }
        if !trimmed.contains("://") { trimmed = "https://" + trimmed }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host() != nil else { return nil }
        return url
    }

    /// The token format Settings expects (`aa_<16 hex>_<secret>`). Only used to warn, not to refuse.
    static func looksLikeToken(_ token: String) -> Bool {
        token.wholeMatch(of: /aa_[0-9a-f]{16}_\S+/) != nil
    }

    /// `{ "error": "..." }` from a failed request, if that's what came back.
    static func errorMessage(from data: Data) -> String? {
        struct Body: Decodable { var error: String? }
        guard let message = (try? JSONDecoder().decode(Body.self, from: data))?.error?
            .trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty else { return nil }
        return message
    }
}

/// Why a question didn't get an answer, in words for the screen. The words depend on where the
/// question went, so `message(from:)` takes the answer source.
nonisolated enum AskFailure: Error, Equatable, Sendable {
    /// No server token.
    case noToken
    case badBaseURL
    case unauthorized
    /// A 402: whatever the server pays for its models has run out.
    case outOfCredit
    case rateLimited(String?)
    case badRequest(String?)
    case server(status: Int, message: String?)
    case offline
    case timedOut
    case unreachable
    case network(String)
    case cutOff
    /// The model (or server) accepted the question and then sent no answer.
    case emptyAnswer

    static func from(status: Int, body: Data) -> AskFailure {
        let message = AskAPI.errorMessage(from: body)
        switch status {
        case 401, 403: return .unauthorized
        case 429: return .rateLimited(message)
        case 400..<500: return .badRequest(message)
        default: return .server(status: status, message: message)
        }
    }

    static func from(_ error: URLError) -> AskFailure {
        switch error.code {
        case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
            return .offline
        case .timedOut:
            return .timedOut
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .secureConnectionFailed,
             .serverCertificateUntrusted, .serverCertificateHasBadDate, .appTransportSecurityRequiresSecureConnection:
            return .unreachable
        default:
            return .network(error.localizedDescription)
        }
    }

    /// In words for the screen. Questions only ever go to the user's Ask server here.
    var message: String {
        switch self {
        case .noToken:
            return "There's no token for your Ask server yet. Add one in Settings."
        case .badBaseURL:
            return "The server address in Settings doesn't look right."
        case .unauthorized:
            return "Your Ask server didn't accept the token. Check it in Settings."
        case .outOfCredit:
            return "The server is out of credit."
        case .rateLimited(let detail):
            return "That's a lot of questions in a short time. Give it a minute and try again." + Self.suffix(detail)
        case .badRequest(let detail):
            return "The server didn't accept that question." + Self.suffix(detail)
        case .server(let status, let detail):
            return "The server had a problem (\(status)). Try again in a moment." + Self.suffix(detail)
        case .offline:
            return "You're offline. Check your connection and try again."
        case .timedOut:
            return "The server took too long to answer. Try again."
        case .unreachable:
            // Servers are often on a private network or VPN (Mike's is on his tailnet).
            return "Couldn't reach your Ask server. Is this phone on its network or VPN?"
        case .network(let detail):
            return "Couldn't reach the server: \(detail)"
        case .cutOff:
            return "The answer was cut off part way through."
        case .emptyAnswer:
            return "The answer came back empty. Try asking again."
        }
    }

    /// Whether Settings is the place to fix it.
    var needsSettings: Bool {
        switch self {
        case .noToken, .badBaseURL, .unauthorized, .unreachable: true
        default: false
        }
    }

    private static func suffix(_ detail: String?) -> String {
        guard let detail, !detail.isEmpty else { return "" }
        return " (\(detail))"
    }
}

/// A `threadbear://quickask?url=<server>&token=<aa_…>` link, from Agent Archive's QR code.
/// Opening one hands every later question, and the token, to whatever server it names, so a
/// link has to be https (Mike's is `tailscale serve`, which always is), and every one is
/// confirmed first, naming its host (ThreadbearApp), the first one included.
/// A Quick Ask setup code, as the server shows it for the phone's own scanner (or Paste):
/// `TBASK1_` and the unpadded base64url of `{"url": <server>, "code": <aq_ code>}`. Plain
/// text, not a link, so the Camera opens nothing with it and no other app can catch it; the
/// code works once, for ten minutes, and is traded for the token at `POST /api/quick/claim`
/// (docs/ask-server.md). It used to be a `threadbear://quickask?url=…&token=…` link, which
/// any app claiming the `threadbear` scheme could have caught as it opened, so a link like
/// that is refused from everywhere now (opened, scanned or pasted), token or not.
nonisolated struct QuickAskSetup: Equatable, Sendable {
    static let textPrefix = "TBASK1_"

    /// The server as the code gave it, kept as typed (Settings shows it).
    var server: String
    var code: String

    enum Refusal: Error, Equatable {
        /// Not a Quick Ask code or link at all: something else (pairing) may want it.
        case notQuickAsk
        /// A `threadbear://quickask` link: never taken, as it could have been caught.
        case link
        /// A setup code, but broken, with an unknown field, or not https.
        case unusable
    }

    static func parse(_ raw: String) -> Result<QuickAskSetup, Refusal> {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: text), url.scheme?.lowercased() == "threadbear", url.host()?.lowercased() == "quickask" {
            return .failure(.link)
        }
        guard text.hasPrefix(textPrefix) else { return .failure(.notQuickAsk) }
        let body = String(text.dropFirst(textPrefix.count))
        guard body.count <= 4096, body.wholeMatch(of: /[A-Za-z0-9_-]+/) != nil,
              let data = base64URLDecoded(body),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["url", "code"],
              let server = object["url"] as? String, let code = object["code"] as? String,
              code.wholeMatch(of: /aq_[A-Za-z0-9_-]{43}/) != nil,
              // No scheme is taken as https, as Settings does; plain http never is, as the
              // token and every question would go over it in the clear.
              let base = AskAPI.normalizeBaseURL(server), base.scheme?.lowercased() == "https",
              // A server, and maybe a path in front of /api: no sign-in, query or fragment
              // that could make the address read as one host and go to another.
              base.user() == nil, base.password() == nil, base.query() == nil, base.fragment() == nil
        else { return .failure(.unusable) }
        return .success(QuickAskSetup(server: server, code: code))
    }

    private static func base64URLDecoded(_ text: String) -> Data? {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        return Data(base64Encoded: base64)
    }

    /// Why a Quick Ask link was refused, wherever it came from.
    static let linkRefusal = "Any app on the phone could have read that link on its way here. In Threadbear, go to Settings › Ask › Scan the code, and scan the code your server shows. Nothing was changed."

    /// What the alert before a claim says: where questions will go, and what it replaces.
    func confirmMessage(current: URL?) -> String {
        let ending = "Only say yes if you just scanned a code from your own server."
        guard let current else { return "Questions will go to \(hostName). \(ending)" }
        if changesServer(from: current) {
            return "Questions will go to \(hostName) instead of \(Self.hostName(current)). \(ending)"
        }
        return "Quick Ask gets a new token for \(hostName). \(ending)"
    }

    /// Host and port, as an alert names it ("mac-mini.tail1234.ts.net:9443").
    var hostName: String { AskAPI.normalizeBaseURL(server).map(Self.hostName) ?? server }

    static func hostName(_ url: URL) -> String {
        let host = url.host()?.lowercased() ?? ""
        return url.port.map { "\(host):\($0)" } ?? host
    }

    /// Whether this code would point Quick Ask somewhere other than `current`, for the
    /// alert's wording. Only the host and port count: a new token for the same server is
    /// the usual re-pair. No server yet is a change too: that first code is the one an
    /// attacker's would most likely be.
    func changesServer(from current: URL?) -> Bool {
        guard let current else { return true }
        return Self.hostName(current) != hostName
    }

    /// `POST <server>/api/quick/claim` with `{"code"}`. The server only, never another
    /// path: the code goes nowhere but where it says it's from.
    func claimRequest() -> URLRequest? {
        guard let base = AskAPI.normalizeBaseURL(server), base.scheme?.lowercased() == "https" else { return nil }
        var request = URLRequest(url: base.appending(path: AskAPI.claimPath))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code])
        request.timeoutInterval = 20
        return request
    }

    /// The token from a claim's answer, or why there isn't one, in words for an alert.
    /// `answeredFrom` is where the answer really came from: only the claim's own address
    /// counts, as a redirect could otherwise have the real server's token kept for this
    /// code's (another) server (Grok's review). The claim follows no redirects either.
    func token(status: Int, body: Data, answeredFrom: URL?) -> Result<String, ClaimFailure> {
        guard let asked = claimRequest()?.url, answeredFrom == asked else {
            return .failure(.refused("The server sent the code somewhere else."))
        }
        return Self.token(status: status, body: body)
    }

    static func token(status: Int, body: Data) -> Result<String, ClaimFailure> {
        if (300..<400).contains(status) { return .failure(.refused("The server sent the code somewhere else.")) }
        guard status == 200 else {
            if status == 410 || status == 400 {
                let reason = (AskAPI.errorMessage(from: body) ?? "That code has expired or was already used")
                    .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
                return .failure(.refused("\(reason). Make a new one on your server and scan that."))
            }
            if status == 404 { return .failure(.refused("That server doesn't take setup codes. Update it, or enter its token by hand.")) }
            return .failure(.refused(AskAPI.errorMessage(from: body) ?? "The server answered \(status)."))
        }
        guard let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let token = object["token"] as? String,
              // Something a header can carry, and no more than a token needs.
              !token.isEmpty, token.count <= 4096, token.wholeMatch(of: /[\x21-\x7E]+/) != nil
        else { return .failure(.refused("The server's answer had no token in it.")) }
        return .success(token)
    }

    enum ClaimFailure: Error, Equatable {
        case refused(String)
        var message: String { switch self { case .refused(let message): message } }
    }
}
