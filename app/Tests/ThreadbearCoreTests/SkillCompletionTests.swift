import XCTest
@testable import ThreadbearCore

final class SkillCompletionTests: XCTestCase {
    func testTriggerUsesOnlyCurrentWordAndUTF16Offsets() {
        XCTAssertEqual(SkillCompletion.token(in: "hello /dep", selection: NSRange(location: 10, length: 0))?.query, "dep")
        XCTAssertNil(SkillCompletion.token(in: "https://example.com", selection: NSRange(location: 19, length: 0)))
        XCTAssertNil(SkillCompletion.token(in: "/tmp/file", selection: NSRange(location: 9, length: 0)))
        XCTAssertNil(SkillCompletion.token(in: "/deploy ", selection: NSRange(location: 8, length: 0)))
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
}
