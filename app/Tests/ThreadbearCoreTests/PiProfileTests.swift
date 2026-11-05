import XCTest
@testable import ThreadbearCore

final class PiProfileTests: XCTestCase {
    func testOldHelloHasNoPiProfiles() throws {
        let result = try JSONDecoder().decode(HelloResult.self, from: Data(#"{"accounts":[{"id":"codex-main","provider":"codex","title":"Codex"}]}"#.utf8))
        XCTAssertTrue(result.piProfiles.isEmpty)
        XCTAssertEqual(result.accounts.first?.provider, "codex")
    }

    func testProfilesDecodeSeparatelyFromAccountsAndIgnoreUnknownFields() throws {
        let json = #"{"accounts":[],"piProfiles":[{"broken":true},{"id":"pi-local","engine":"pi","title":"Local Pi","executable":"pi","configDir":"/test/pi","connection":{"provider":"ollama","model":"vendor/model","future":true},"capabilities":{"threads":false,"future":true},"future":true}]}"#
        let result = try JSONDecoder().decode(HelloResult.self, from: Data(json.utf8))
        XCTAssertTrue(result.accounts.isEmpty)
        XCTAssertEqual(result.piProfiles.count, 1)
        let profile = try XCTUnwrap(result.piProfiles.first)
        XCTAssertEqual(profile.engine, "pi")
        XCTAssertEqual(profile.connection.provider, "ollama")
        XCTAssertEqual(profile.connection.model, "vendor/model")
        XCTAssertFalse(profile.capabilities.threads)
    }
}
