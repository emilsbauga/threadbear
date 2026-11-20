import Foundation
import Testing
@testable import QuickAskCore

struct AskAPITests {
    private let perth = TimeZone(identifier: "Australia/Perth")!
    private let now = Date(timeIntervalSince1970: 1_792_735_560) // 2026-10-23T06:06:00Z

    private func json(_ data: Data) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test func bodyMatchesTheContract() throws {
        let history = [Exchange(question: "What did I do yesterday?", answer: "You worked on Pebble.")]
        let body = AskAPI.body(question: "  And the day before?  ", history: history, timeZone: perth, now: now)
        let object = try json(try AskAPI.encode(body))

        #expect(object["question"] as? String == "And the day before?")
        #expect(object["timezone"] as? String == "Australia/Perth")
        #expect(object["clientTime"] as? String == "2026-10-23T14:06:00+08:00")
        let sent = try #require(object["history"] as? [[String: String]])
        #expect(sent == [["question": "What did I do yesterday?", "answer": "You worked on Pebble."]])
        #expect(Set(object.keys) == ["question", "history", "timezone", "clientTime"])
    }

    @Test func historyIsLeftOutWhenEmpty() throws {
        let body = AskAPI.body(question: "Hello there", history: [], timeZone: perth, now: now)
        let object = try json(try AskAPI.encode(body))
        #expect(object["history"] == nil)
    }

    @Test func historyKeepsTheLastThreeOldestFirstAndSkipsEmptyAnswers() {
        let history = (1...5).map { Exchange(question: "Q\($0)", answer: $0 == 4 ? " " : "A\($0)") }
        let body = AskAPI.body(question: "Q6", history: history, timeZone: perth, now: now)
        #expect(body.history?.map(\.question) == ["Q2", "Q3", "Q5"])
    }

    @Test func clientTimeUsesTheGivenZone() {
        #expect(AskAPI.isoTime(now, in: TimeZone(identifier: "UTC")!) == "2026-10-23T06:06:00Z")
        #expect(AskAPI.isoTime(now, in: TimeZone(identifier: "Europe/London")!) == "2026-10-23T07:06:00+01:00")
    }

    @Test func askRequestHeaders() throws {
        let body = AskAPI.body(question: "Hi there", history: [], timeZone: perth, now: now)
        let request = try AskAPI.askRequest(baseURL: URL(string: "https://happy-bear-123.convex.site")!,
                                            token: "aa_0123456789abcdef_secret", body: body)
        #expect(request.url?.absoluteString == "https://happy-bear-123.convex.site/api/quick/ask")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer aa_0123456789abcdef_secret")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Accept") == "application/x-ndjson")
        #expect(request.timeoutInterval == 75)
        #expect(try AskBody.decode(request.httpBody) == body)
    }

    @Test func pingRequest() {
        let request = AskAPI.pingRequest(baseURL: URL(string: "http://127.0.0.1:8787")!)
        #expect(request.url?.absoluteString == "http://127.0.0.1:8787/api/quick/ping")
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func baseURLNormalising() {
        #expect(AskAPI.normalizeBaseURL(" https://calm-otter-456.convex.site/ ")?.absoluteString == "https://calm-otter-456.convex.site")
        #expect(AskAPI.normalizeBaseURL("calm-otter-456.convex.site")?.absoluteString == "https://calm-otter-456.convex.site")
        #expect(AskAPI.normalizeBaseURL("http://127.0.0.1:8787")?.absoluteString == "http://127.0.0.1:8787")
        #expect(AskAPI.normalizeBaseURL("") == nil)
        #expect(AskAPI.normalizeBaseURL("ftp://example.com") == nil)
    }

    @Test func tokenShape() {
        #expect(AskAPI.looksLikeToken("aa_0123456789abcdef_s3cr3t-Value"))
        #expect(!AskAPI.looksLikeToken("aa_0123_secret"))
        #expect(!AskAPI.looksLikeToken("Bearer aa_0123456789abcdef_x"))
    }

    @Test func failuresInPlainWords() {
        let body = Data(#"{"error":"Slow down"}"#.utf8)
        #expect(AskFailure.from(status: 401, body: Data()) == .unauthorized)
        #expect(AskFailure.from(status: 429, body: body) == .rateLimited("Slow down"))
        #expect(AskFailure.from(status: 400, body: Data(#"{"error":"question is required"}"#.utf8)) == .badRequest("question is required"))
        #expect(AskFailure.from(status: 503, body: Data("<html>".utf8)) == .server(status: 503, message: nil))
        #expect(AskFailure.unauthorized.message.contains("Settings"))
        #expect(AskFailure.unauthorized.needsSettings)
        #expect(AskFailure.from(URLError(.notConnectedToInternet)) == .offline)
        #expect(AskFailure.from(URLError(.timedOut)) == .timedOut)
        #expect(AskFailure.from(URLError(.cannotFindHost)) == .unreachable)
    }
}

private extension AskBody {
    static func decode(_ data: Data?) throws -> AskBody {
        try JSONDecoder().decode(AskBody.self, from: try #require(data))
    }
}

/// Settings › Ask's own scanner and Paste read a setup code; no link is taken (QuickAskSetup).
struct QuickAskSetupTests {
    private let code = "aq_" + String(repeating: "A", count: 43)

    private func text(_ object: Any) -> String {
        let data = try! JSONSerialization.data(withJSONObject: object)
        let body = data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return QuickAskSetup.textPrefix + body
    }

    @Test func aSetupCodeIsRead() throws {
        let parsed = try QuickAskSetup.parse(text(["url": "https://mac-mini.tail1234.ts.net:9443", "code": code])).get()
        #expect(parsed.server == "https://mac-mini.tail1234.ts.net:9443")
        #expect(parsed.code == code)
        #expect(parsed.hostName == "mac-mini.tail1234.ts.net:9443")
        // No scheme is https; surrounding whitespace from a paste is fine.
        #expect(try QuickAskSetup.parse("  " + text(["url": "mac-mini.example.ts.net", "code": code]) + "\n").get().server == "mac-mini.example.ts.net")
        // Every padding length decodes.
        for host in ["a.example", "ab.example", "abc.example"] {
            #expect(try QuickAskSetup.parse(text(["url": "https://\(host)", "code": code])).get().hostName == host)
        }
    }

    /// Daybreak's follow-up to finding 127: a threadbear://quickask link carried the token,
    /// and any app claiming the scheme could catch it as the Camera opened it. Refused
    /// wherever it comes from, with or without a token in it.
    @Test func quickAskLinksAreRefusedTokenOrNot() {
        for link in [
            "threadbear://quickask?url=https%3A%2F%2Fmac-mini.tail1234.ts.net%3A9443&token=aa_0123456789abcdef_x",
            "THREADBEAR://QuickAsk?url=https%3A%2F%2Fok.example&token=t",
            "threadbear://quickask?url=https%3A%2F%2Fok.example&code=\(code)",
            "threadbear://quickask",
        ] {
            #expect(QuickAskSetup.parse(link) == .failure(.link), "\(link)")
        }
        #expect(QuickAskSetup.parse("threadbear://pair?url=https%3A%2F%2Fok.example&token=t") == .failure(.notQuickAsk))
        #expect(QuickAskSetup.parse("TBPAIR1_abc") == .failure(.notQuickAsk))
    }

    @Test func brokenAndPlainHttpCodesAreRefused() {
        let bad: [String] = [
            text(["url": "http://evil.example", "code": code]),
            text(["url": "https://ok.example"]),
            text(["url": "https://ok.example", "code": "aq_short"]),
            text(["url": "https://ok.example", "code": code, "token": "aa_x"]),
            text(["url": 42, "code": code]),
            text(["https://ok.example", code]),
            // An address that could read as one host and go to another.
            text(["url": "https://bruce.example@evil.example", "code": code]),
            text(["url": "https://evil.example?x=https://bruce.example", "code": code]),
            text(["url": "https://evil.example#bruce.example", "code": code]),
            QuickAskSetup.textPrefix,
            QuickAskSetup.textPrefix + "not base64!",
            QuickAskSetup.textPrefix + String(repeating: "A", count: 5000),
        ]
        for value in bad {
            #expect(QuickAskSetup.parse(value) == .failure(.unusable), "\(value)")
        }
    }

    @Test func theClaimGoesOnlyToTheCodesOwnServer() throws {
        let setup = try QuickAskSetup.parse(text(["url": "https://mac-mini.example.ts.net:9443/", "code": code])).get()
        let request = try #require(setup.claimRequest())
        #expect(request.url?.absoluteString == "https://mac-mini.example.ts.net:9443/api/quick/claim")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? [String: String]
        #expect(body == ["code": code])
    }

    @Test func aClaimsAnswerGivesTheTokenOrSaysWhy() {
        let ok = Data(#"{"token":"aa_0123456789abcdef_secret","expiresAt":1}"#.utf8)
        #expect(QuickAskSetup.token(status: 200, body: ok) == .success("aa_0123456789abcdef_secret"))
        let used = Data(#"{"error":"That setup code has expired or was already used"}"#.utf8)
        #expect(QuickAskSetup.token(status: 410, body: used) == .failure(.refused("That setup code has expired or was already used. Make a new one on your server and scan that.")))
        #expect(QuickAskSetup.token(status: 404, body: Data()) == .failure(.refused("That server doesn't take setup codes. Update it, or enter its token by hand.")))
        // No token, or one no header could carry, is no token.
        for body in [#"{}"#, #"{"token":""}"#, #"{"token":"a b"}"#, #"{"token":"x\ny"}"#, "nope"] {
            #expect(QuickAskSetup.token(status: 200, body: Data(body.utf8)) == .failure(.refused("The server's answer had no token in it.")), "\(body)")
        }
    }

    /// Grok's review: a code naming another server, answered with a redirect to the real
    /// one, would have had the real server's token kept for the other. Only an answer from
    /// the claim's own address counts, and a redirect itself is refused.
    @Test func anAnswerFromAnywhereButTheClaimsOwnAddressIsRefused() throws {
        let setup = try QuickAskSetup.parse(text(["url": "https://attacker.example", "code": code])).get()
        let ok = Data(#"{"token":"aa_0123456789abcdef_secret"}"#.utf8)
        let sentElsewhere = QuickAskSetup.ClaimFailure.refused("The server sent the code somewhere else.")
        #expect(setup.token(status: 200, body: ok, answeredFrom: URL(string: "https://bruce.example:9443/api/quick/claim")) == .failure(sentElsewhere))
        #expect(setup.token(status: 200, body: ok, answeredFrom: nil) == .failure(sentElsewhere))
        #expect(setup.token(status: 307, body: Data(), answeredFrom: URL(string: "https://attacker.example/api/quick/claim")) == .failure(sentElsewhere))
        #expect(setup.token(status: 200, body: ok, answeredFrom: URL(string: "https://attacker.example/api/quick/claim")) == .success("aa_0123456789abcdef_secret"))
    }

    @Test func onlyAnotherHostCountsAsAChange() throws {
        let parsed = try QuickAskSetup.parse(text(["url": "https://mac-mini.example.ts.net:9443", "code": code])).get()
        // The first code counts as a change: it's asked about like any other.
        #expect(parsed.changesServer(from: nil))
        #expect(!parsed.changesServer(from: URL(string: "https://Mac-Mini.example.ts.net:9443/")!))
        #expect(parsed.changesServer(from: URL(string: "https://mac-mini.example.ts.net")!))
        #expect(parsed.changesServer(from: URL(string: "https://evil.example:9443")!))
    }
}
