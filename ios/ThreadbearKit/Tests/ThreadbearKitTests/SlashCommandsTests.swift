import Foundation
import Testing
@testable import ThreadbearKit

/// The phone's slash command palette (backend API 61): the list comes back
/// as a slashCommands command's result.
struct SlashCommandsTests {
    @Test func aCommandsResultDecodesAsTheList() throws {
        let json = #"{"state":"done","result":[{"name":"compact","source":"cli"},{"name":"deslop","description":"Clean","source":"skill","scope":"user","path":"/u/.claude/skills/deslop/SKILL.md"}]}"#
        let status = try JSONDecoder().decode(CommandStatus.self, from: Data(json.utf8))
        #expect(status.commands?.map(\.name) == ["compact", "deslop"])
        #expect(status.commands?.last?.path == "/u/.claude/skills/deslop/SKILL.md")
    }

    @Test func anyOtherResultReadsAsNone() throws {
        for json in [#"{"state":"done","result":{"items":[]}}"#, #"{"state":"pending"}"#] {
            let status = try JSONDecoder().decode(CommandStatus.self, from: Data(json.utf8))
            #expect(status.commands == nil)
        }
    }

    @Test func theFakeAnswersWithAList() async throws {
        let backend = FakeBackend()
        let id = try await backend.slashCommands(threadId: "t1")
        for try await status in backend.command(id) {
            #expect(status?.state == .done)
            #expect(status?.commands?.isEmpty == false)
            break
        }
    }

    // The palette's rules against the cases the desktop app and Android run too
    // (shared/cases/slash-commands.json), carried over from the Mac app's tests.
    private static func shared(_ file: String) throws -> [String: Any] {
        // ios/ThreadbearKit/Tests/ThreadbearKitTests/ -> the repo.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: repo.appendingPathComponent(file))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private static func commands(_ json: Any) throws -> [SlashCommand] {
        try JSONDecoder().decode([SlashCommand].self, from: JSONSerialization.data(withJSONObject: json))
    }

    /// Equal as JSON: what the palette gave against the case's expect.
    private static func same(_ actual: Any?, _ expect: Any?) -> Bool {
        let a = actual.map { $0 as AnyObject } ?? NSNull()
        let e = expect.map { $0 as AnyObject } ?? NSNull()
        return (a as? NSObject)?.isEqual(e) == true
    }

    @Test func theSharedCases() throws {
        let file = try Self.shared("shared/cases/slash-commands.json")
        var lists: [String: [SlashCommand]] = [:]
        for (key, value) in try #require(file["lists"] as? [String: Any]) { lists[key] = try Self.commands(value) }
        let cases = try #require(file["cases"] as? [[String: Any]])
        #expect(cases.count > 50)
        for c in cases {
            let name = try #require(c["name"] as? String)
            if (c["differs"] as? [String: Any])?["ios"] != nil { continue }
            let i = try #require(c["input"] as? [String: Any], "\(name)")
            let text = i["text"] as? String ?? ""
            let query = i["query"] as? String ?? ""
            let list = (i["list"] as? String).flatMap { lists[$0] } ?? []
            let recent = i["recent"] as? [String] ?? []
            let command = try i["command"].map { try Self.commands([$0])[0] }
            let provider = i["provider"] as? String ?? ""
            let actual: Any?
            switch i["op"] as? String {
            case "query": actual = SlashPalette.query(in: text)
            case "typed":
                actual = SlashPalette.typed(in: text).map { ["query": $0.query, "before": String(text.utf16.prefix($0.start)) ?? ""] }
            case "midMessage": actual = SlashPalette.midMessage(list).map(\.name)
            case "matches":
                let category = try #require(SlashPalette.Category(rawValue: i["category"] as? String ?? ""), "\(name)")
                actual = SlashPalette.matches(list, query: query, category: category, recent: recent).map(\.name)
            case "counts": actual = SlashPalette.counts(list, query: query, recent: recent).map { [$0.0.rawValue, $0.1] as [Any] }
            case "usage": actual = try #require(command, "\(name)").usage
            case "fill": actual = SlashPalette.fill(try #require(command, "\(name)"), forArguments: i["forArguments"] as? Bool ?? false)
            case "origin": actual = SlashPalette.origin(of: try #require(command, "\(name)"), provider: provider)
            case "cliTitle": actual = SlashPalette.Category.cli.title(provider: provider)
            case "shortPath": actual = SlashPalette.shortPath(i["path"] as? String ?? "", home: i["home"] as? String ?? "")
            case "used": actual = SlashPalette.used(i["name"] as? String ?? "", recent: recent)
            case "description": actual = String(SlashPalette.description(text).characters)
            default:
                Issue.record("unknown op in \(name)")
                continue
            }
            #expect(Self.same(actual, c["expect"]), "\(name): got \(String(describing: actual))")
        }
    }

    /// The palette's columns and sizes (shared/cases/slash-palette-layout.json), as the desktop app has them.
    @Test func theSharedLayoutCases() throws {
        let cases = try #require(try Self.shared("shared/cases/slash-palette-layout.json")["cases"] as? [[String: Any]])
        #expect(cases.count > 20)
        for c in cases {
            let name = try #require(c["name"] as? String)
            if (c["differs"] as? [String: Any])?["ios"] != nil { continue }
            let i = try #require(c["input"] as? [String: Any], "\(name)")
            func n(_ key: String) -> Double { (i[key] as? NSNumber)?.doubleValue ?? .nan }
            let actual: Any
            switch i["op"] as? String {
            case "columnWidths":
                let w = SlashPalette.columnWidths(total: n("total"), categories: n("categories"), list: n("list"), chosen: i["chosen"] as? Bool ?? false)
                actual = ["categories": w.categories, "list": w.list]
            case "height": actual = SlashPalette.height(window: n("window"))
            case "layoutHeight": actual = SlashPalette.Layout.height(n("value"), window: n("window"))
            case "layoutWidth": actual = SlashPalette.Layout.width(n("value"), window: n("window"))
            case "column": actual = SlashPalette.Layout.column(n("value"), least: n("least"), others: n("others"), total: n("total"))
            default:
                Issue.record("unknown op in \(name)")
                continue
            }
            #expect(Self.same(actual, c["expect"]), "\(name): got \(actual)")
        }
    }
}
