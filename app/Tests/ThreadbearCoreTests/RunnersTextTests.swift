import Foundation
import Testing
@testable import ThreadbearCore

@Suite struct RunnersTextTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func stateLines() {
        let up = RunnerInfo(id: "m5", name: "m5", online: true, isSelf: true, startedAt: now.addingTimeInterval(-3 * 3600))
        #expect(RunnersText.stateLine(up, now: now) == "Online, up 3h")
        let draining = RunnerInfo(id: "b", name: "bruce", online: true, draining: true)
        #expect(RunnersText.state(draining) == .updating)
        #expect(RunnersText.stateLine(draining, now: now) == "Updating")
        let down = RunnerInfo(id: "c", name: "cloud", online: false, lastSeenAt: now.addingTimeInterval(-2 * 86_400))
        #expect(RunnersText.stateLine(down, now: now) == "Offline, last seen 2d ago")
        // An older runner says none of it.
        #expect(RunnersText.stateLine(RunnerInfo(id: "o", name: "old", online: true), now: now) == "Online")
        #expect(RunnersText.stateLine(RunnerInfo(id: "o", name: "old", online: false), now: now) == "Offline")
    }

    @Test func buildIsTheReleaseCommit() {
        #expect(RunnersText.build(RunnerInfo(id: "a", name: "a", version: "0.1.0+20261105T064853Z-c4d90ca", release: "20261105T064853Z-c4d90ca")) == "c4d90ca")
        #expect(RunnersText.build(RunnerInfo(id: "a", name: "a", version: "0.1.0+source")) == "0.1.0+source")
        #expect(RunnersText.build(RunnerInfo(id: "a", name: "a")) == nil)
    }

    @Test func tooltipSaysWhoIsDown() {
        let m5 = RunnerInfo(id: "m5", name: "m5", online: true, isSelf: true)
        let bruce = RunnerInfo(id: "b", name: "bruce", online: true)
        let cloud = RunnerInfo(id: "c", name: "cloud", online: false)
        #expect(RunnersText.tooltip([m5, bruce]) == "Runners\nBoth online")
        #expect(RunnersText.tooltip([m5, bruce, cloud]) == "Runners\n2 of 3 online\ncloud offline")
        var updating = bruce
        updating.draining = true
        #expect(RunnersText.tooltip([m5, updating, cloud]) == "Runners\n2 of 3 online\ncloud offline\nbruce is updating")
    }

    @Test func runningIsEachRunnersOwn() {
        let m5 = RunnerInfo(id: "m5", name: "m5", online: true, isSelf: true)
        let bruce = RunnerInfo(id: "b", name: "bruce", online: true)
        let mine = ThreadSummary(id: "t1", title: "here")
        var theirs = ThreadSummary(id: "t2", title: "there")
        theirs.runnerId = "b"
        #expect(RunnersText.running(on: m5, in: [mine, theirs]).map(\.id) == ["t1"])
        #expect(RunnersText.running(on: bruce, in: [mine, theirs]).map(\.id) == ["t2"])
    }

    @Test func decodesTheNewFields() throws {
        let json = #"{"id":"b","name":"bruce","online":true,"self":false,"version":"0.1.0+x","release":"x","startedAt":"2026-11-05T01:00:00.000Z","draining":true}"#
        let r = try JSONDecoder().decode(RunnerInfo.self, from: Data(json.utf8))
        #expect(r.version == "0.1.0+x")
        #expect(r.release == "x")
        #expect(r.startedAt != nil)
        #expect(r.draining)
        let old = try JSONDecoder().decode(RunnerInfo.self, from: Data(#"{"id":"b","name":"bruce","online":true}"#.utf8))
        #expect(old.version == nil && old.startedAt == nil && !old.draining)
    }

    @Test func figures() throws {
        let gib: Double = 1024 * 1024 * 1024
        let json = #"{"runnerId":"b","at":"2026-11-05T08:00:00.000Z","cpuPercent":23.4,"cores":8,"memUsed":7730941132.8,"memTotal":8589934592,"diskFree":5368709120,"diskTotal":245107195904,"load1":2.13,"uptimeSec":360000,"machine":"Apple M2","os":"macOS 27.2","later":1}"#
        let s = try JSONDecoder().decode(RunnerMachineStats.self, from: Data(json.utf8))
        let g = RunnersText.gauges(s)
        #expect(g.map(\.title) == ["CPU", "Memory", "Disk"])
        #expect(g[0].text == "23%")
        #expect(!g[0].high)
        #expect(g[1].text == "7.2 of 8 GB")
        #expect(g[1].high, "90% of memory used")
        #expect(g[2].text == "5 GB free")
        #expect(g[2].high, "under 10 GB free")
        #expect(abs(g[2].fraction - (1 - 5 * gib / 245107195904)) < 0.0001)
        #expect(RunnersText.machineLines(s) == ["Apple M2, macOS 27.2", "Machine up 4d, load 2.1 on 8 cores"])
        #expect(RunnersText.staleLine(s, now: s.at.addingTimeInterval(30)) == nil)
        #expect(RunnersText.staleLine(s, now: s.at.addingTimeInterval(300)) == "From 5m ago")
        #expect(RunnersText.gb(2 * 1024 * gib) == "2 TB")
        #expect(RunnersText.gb(212.4 * gib) == "212 GB")
        #expect(RunnersText.gb(9.06 * gib) == "9.1 GB")
        // A Linux box with no load figure or model.
        let bare = RunnerMachineStats(runnerId: "c", cpuPercent: 5, cores: 2, uptimeSec: 90)
        #expect(RunnersText.gauges(bare).map(\.title) == ["CPU"])
        #expect(RunnersText.machineLines(bare) == ["Machine up 1m"])
    }
}
