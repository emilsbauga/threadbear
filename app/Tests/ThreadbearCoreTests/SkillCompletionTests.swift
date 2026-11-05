import XCTest
@testable import ThreadbearCore

final class SkillCompletionTests: XCTestCase {
    func testTriggerUsesOnlyCurrentWordAndUTF16Offsets() {
        XCTAssertEqual(SkillCompletion.token(in: "hello /dep", selection: NSRange(location: 10, length: 0))?.query, "dep")
        XCTAssertNil(SkillCompletion.token(in: "https://example.com", selection: NSRange(location: 19, length: 0)))
        XCTAssertNil(SkillCompletion.token(in: "/tmp/file", selection: NSRange(location: 9, length: 0)))
        XCTAssertEqual(SkillCompletion.token(in: "/deploy ", selection: NSRange(location: 8, length: 0))?.query, "deploy ")
        XCTAssertNil(SkillCompletion.token(in: "$deploy ", selection: NSRange(location: 8, length: 0)))
        XCTAssertNil(SkillCompletion.token(in: "/deploy", selection: NSRange(location: 0, length: 7)))
        let words = "🙂 /dep then"
        let token = SkillCompletion.token(in: words, selection: NSRange(location: 7, length: 0))!
        XCTAssertEqual(token.range, NSRange(location: 3, length: 4))
        XCTAssertEqual((words as NSString).replacingCharacters(in: token.range, with: "$deploy "), "🙂 $deploy  then")
        XCTAssertEqual(SkillCompletion.token(in: "$dep", selection: NSRange(location: 4, length: 0))?.query, "dep")
    }

    func testMatchesNamesTitlesAndDescriptions() {
        let skills = [ComposerSkill(name: "ship", title: "Deploy", description: "Publish website", path: "/a", scope: "user"), ComposerSkill(name: "audit", description: "Review", path: "/b", scope: "repo")]
        XCTAssertEqual(SkillCompletion.matches(skills, query: "DEPLOY").map(\.name), ["ship"])
        XCTAssertEqual(SkillCompletion.matches(skills, query: "website").map(\.name), ["ship"])
        XCTAssertTrue(SkillCompletion.matches(skills, query: "missing").isEmpty)
    }
    func testSearchUsesWordsAndHyphensInterchangeably() {
        let skills = [
            ComposerSkill(name: "usage-budget", title: "Usage budget", description: "Conserve allowance", path: "/usage", scope: "user"),
            ComposerSkill(name: "github-create", description: "Publish a repository", path: "/github", scope: "user"),
        ]
        let text = "Please /github create"
        let token = SkillCompletion.token(in: text, selection: NSRange(location: (text as NSString).length, length: 0))
        XCTAssertEqual(token?.query, "github create")
        XCTAssertEqual(token?.range, NSRange(location: 7, length: 14))
        XCTAssertEqual(SkillCompletion.matches(skills, query: "github create").map(\.name), ["github-create"])
        XCTAssertEqual(SkillCompletion.matches(skills, query: "usage-budget").map(\.name), ["usage-budget"])
        XCTAssertEqual(SkillCompletion.matches(skills, query: "usage budget").map(\.name), ["usage-budget"])
        XCTAssertNil(SkillCompletion.token(in: "https://github.com/create", selection: NSRange(location: 25, length: 0)))
        XCTAssertNil(SkillCompletion.token(in: "/tmp/my file", selection: NSRange(location: 12, length: 0)))
    }

}
