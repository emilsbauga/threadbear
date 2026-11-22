import Foundation
import Testing
import ThreadbearKit

/// The phone's copy of the Mac's LinkPolicy, which LinkGate decides with:
/// a reply's link to another app waits for a yes, a web page opens
/// (Daybreak, 7 Nov). The Mac's LinkPolicyTests checks the two files match.
@Suite struct LinkPolicyTests {
    @Test func onlyWebPagesOpenWithoutAsking() throws {
        for web in ["https://example.com/", "HTTP://localhost:5173/"] {
            guard case .web = LinkPolicy.kind(of: try #require(URL(string: web))) else { Issue.record("\(web) is web"); continue }
        }
        for other in ["shortcuts://run-shortcut?name=x", "tel:123", "JaVaScRiPt:alert(1)", "itms-services://?action=download-manifest",
                      "prefs:root=General", "threadbear://pair?url=x"] {
            guard case .ask = LinkPolicy.kind(of: try #require(URL(string: other))) else { Issue.record("\(other) asks"); continue }
        }
        guard case .file = LinkPolicy.kind(of: try #require(URL(string: "file:///etc/hosts"))) else { Issue.record("a file is the Mac's"); return }
    }

    struct Cases: Decodable {
        struct Case: Decodable {
            var name: String
            var input: String
            var expect: String
            var differs: [String: String]?
        }
        var cases: [Case]
    }

    /// The cases the desktop app, Android and the website run too
    /// (shared/cases/link-policy.json). A string URL can't read is refused.
    @Test func theSharedCases() throws {
        // ios/ThreadbearKit/Tests/ThreadbearKitTests/ -> the repo.
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let url = repo.appendingPathComponent("shared/cases/link-policy.json")
        let cases = try JSONDecoder().decode(Cases.self, from: Data(contentsOf: url)).cases
        #expect(cases.count >= 40)
        for c in cases where c.differs?["ios"] == nil {
            let kind: String
            switch URL(string: c.input).map(LinkPolicy.kind(of:)) {
            case .web: kind = "web"
            case .ask: kind = "ask"
            case .file: kind = "file"
            case .refuse, nil: kind = "refuse"
            }
            #expect(kind == c.expect, "\(c.name)")
        }
    }
}
