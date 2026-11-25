import Foundation
import Testing
@testable import ThreadbearKit

/// Sharing a thread by link from the phone (phone:share, backend API 8), as
/// the website's Share control does. Ville, on a fork, couldn't copy or share
/// a thread's link from the app (22 Nov): the Mac and the website had it.
@Suite struct SharingTests {
    let site = URL(string: "https://happy-otter-123.convex.site")!

    // MARK: The link

    @Test func theSiteIsWhatTheBackendSays() {
        #expect(ThreadSharing.site(said: "https://threadbear-site.example.com/", deploymentURL: nil)
            == URL(string: "https://threadbear-site.example.com"))
        #expect(ThreadSharing.site(said: "http://127.0.0.1:13211", deploymentURL: nil) == URL(string: "http://127.0.0.1:13211"))
    }

    @Test func elseACloudDeploymentsSiteTwin() {
        let cloud = URL(string: "https://happy-otter-123.convex.cloud")!
        #expect(ThreadSharing.site(said: nil, deploymentURL: cloud) == site)
        #expect(ThreadSharing.site(said: "", deploymentURL: cloud) == site)
        // Only a web address counts as the site.
        #expect(ThreadSharing.site(said: "javascript:alert(1)", deploymentURL: cloud) == site)
        // A self-hosted backend that doesn't say: no link to show.
        #expect(ThreadSharing.site(said: nil, deploymentURL: URL(string: "http://127.0.0.1:3210")!) == nil)
        #expect(ThreadSharing.site(said: nil, deploymentURL: nil) == nil)
    }

    @Test func theLinkIsTheSiteThenSlashSThenTheSlug() {
        #expect(ThreadSharing.link(site: site, slug: "Ab-c_9") == URL(string: "https://happy-otter-123.convex.site/s/Ab-c_9"))
        #expect(ThreadSharing.link(site: URL(string: "https://x.example/")!, slug: "abc") == URL(string: "https://x.example/s/abc"))
        // A slug is base64url; anything else can't break out of the path.
        #expect(ThreadSharing.link(site: site, slug: "a/b?c")?.absoluteString == "https://happy-otter-123.convex.site/s/a%2Fb%3Fc")
        #expect(ThreadSharing.link(site: site, slug: "") == nil)
    }

    // MARK: The command

    @Test func sendsPhoneShare() async throws {
        let transport = RecordingTransport()
        let backend = ConvexBackend(transport: transport, token: "tb_x")
        #expect(try await backend.share(threadId: "t1", request: .on) == "cmd_1")
        _ = try await backend.share(threadId: "t1", request: .off)
        _ = try await backend.share(threadId: "t1", request: .newLink)
        let calls = transport.calls.withLock { $0 }
        #expect(calls.map(\.0) == ["phone:share", "phone:share", "phone:share"])
        #expect(calls[0].1 == ["token": .string("tb_x"), "threadId": .string("t1"), "access": .string("link")])
        #expect(calls[1].1 == ["token": .string("tb_x"), "threadId": .string("t1"), "access": .string("off")])
        #expect(calls[2].1 == ["token": .string("tb_x"), "threadId": .string("t1"), "access": .string("link"), "newLink": .bool(true)])
    }

    @Test func sharingNeedsTheBackendThatHasIt() {
        #expect(BackendCompatibility.shareAPIVersion == 8)
    }

    // MARK: What the sheet shows

    private let at = Date(timeIntervalSince1970: 1_800_000_000)
    private var shared: ThreadShare { ThreadShare(access: "link", slug: "old") }

    private func shown(_ share: ThreadShare?, _ command: PendingCommand = .idle, asked: ShareRequest? = nil) -> SharingState {
        ThreadSharing.shown(share, site: site, command: command, value: asked.map { ThreadSharing.value($0, replacing: share?.slug) })
    }

    @Test func atRestItsTheRow() {
        let never = shown(nil)
        #expect(!never.on && never.link == nil && !never.busy && !never.making)
        let on = shown(shared)
        #expect(on.on && on.link == URL(string: "https://happy-otter-123.convex.site/s/old"))
        // "off" keeps the slug, but there's no link to hand out.
        let off = shown(ThreadShare(access: "off", slug: "old"))
        #expect(!off.on && off.link == nil)
        // A record from the days of sharing with people reads as off.
        #expect(!shown(ThreadShare(access: "people", slug: "old")).on)
    }

    @Test func turningItOnShowsAtOnceAndWaitsForTheLink() {
        let s = shown(nil, .sending(since: at), asked: .on)
        #expect(s.on && s.making && s.busy && s.link == nil && s.spinning == .on)
        // Shared before: the same link comes back, so it shows straight away.
        let again = shown(ThreadShare(access: "off", slug: "old"), .queued(id: "c", since: at), asked: .on)
        #expect(again.on && !again.making && again.link == URL(string: "https://happy-otter-123.convex.site/s/old"))
    }

    @Test func turningItOffHidesTheLinkAtOnce() {
        let s = shown(shared, .taken(id: "c", since: at), asked: .off)
        #expect(!s.on && s.link == nil && s.busy && s.spinning == .off)
    }

    @Test func aNewLinkHidesTheOldOneUntilTheNewOneComes() {
        let value = ThreadSharing.value(.newLink, replacing: "old")
        let waiting = ThreadSharing.shown(shared, site: site, command: .queued(id: "c", since: at), value: value)
        #expect(waiting.on && waiting.link == nil && waiting.making && waiting.spinning == .newLink)
        // Done, the row not caught up yet: still waiting for the new slug.
        let done = ThreadSharing.shown(shared, site: site, command: .done(id: "c", result: nil), value: value)
        #expect(done.link == nil && done.making && done.busy && done.spinning == nil)
        // The row has the new slug.
        let landed = ThreadSharing.shown(ThreadShare(access: "link", slug: "new"), site: site, command: .done(id: "c", result: nil), value: value)
        #expect(landed.link == URL(string: "https://happy-otter-123.convex.site/s/new") && !landed.making)
    }

    @Test func aRefusalPutsItBackAndSaysWhy() {
        let s = shown(nil, .failed(id: "c", reason: "No such thread"), asked: .on)
        #expect(!s.on && !s.busy && s.failure == "No such thread")
        let quiet = shown(nil, .failed(id: "c", reason: nil), asked: .on)
        #expect(quiet.failure == "The Mac couldn't change how this thread is shared.")
    }

    @Test func aMacAsleepKeepsTheChangeAndSaysSo() {
        let s = shown(nil, .timedOut(id: "c", taken: false), asked: .on)
        #expect(s.on && !s.busy && s.note != nil && s.failure == nil)
        // It never reached the server: put back.
        let lost = shown(nil, .timedOut(id: nil, taken: false), asked: .on)
        #expect(!lost.on && lost.note != nil)
    }

    @Test func noSiteNoLink() {
        let s = ThreadSharing.shown(shared, site: nil, command: .idle, value: nil)
        #expect(s.on && s.link == nil && !s.making)
    }

    // MARK: The demo

    @Test func theFakeSharesAndGivesNewLinks() async throws {
        let backend = FakeBackend()
        #expect(try await thread(backend, "a1").share == nil)
        try await finish(backend, try await backend.share(threadId: "a1", request: .on))
        let first = try #require(try await thread(backend, "a1").share)
        #expect(first.isOn && !first.slug.isEmpty)
        try await finish(backend, try await backend.share(threadId: "a1", request: .off))
        #expect(try await thread(backend, "a1").share == ThreadShare(access: "off", slug: first.slug))
        try await finish(backend, try await backend.share(threadId: "a1", request: .newLink))
        let second = try #require(try await thread(backend, "a1").share)
        #expect(second.isOn && second.slug != first.slug)
        #expect(try await backend.me().site != nil)
    }

    private func thread(_ backend: FakeBackend, _ id: String) async throws -> PhoneThread {
        for try await detail in backend.thread(id) { return try #require(detail?.thread) }
        throw TransportError.server("no thread")
    }

    private func finish(_ backend: FakeBackend, _ id: String) async throws {
        for try await status in backend.command(id) where status?.state == .done { return }
    }
}
