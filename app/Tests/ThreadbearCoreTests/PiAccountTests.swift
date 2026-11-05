import XCTest
@testable import ThreadbearCore

final class PiAccountTests: XCTestCase {
    func testPiAccountKeepsItsProfileConnectionAndModel() throws {
        let json = #"{"id":"pi:local","provider":"pi","title":"Pi · Local","configDir":"/profiles/local","piProfileId":"local","executable":"/bin/pi","connection":{"provider":"ollama","model":"test-model"},"defaultModel":"test-model","models":[{"id":"test-model","model":"test-model","title":"Test model","effortLevels":[]}]}"#
        let account = try JSONDecoder().decode(Account.self, from: Data(json.utf8))
        XCTAssertEqual(account.piProfileId, "local")
        XCTAssertEqual(account.connection?.provider, "ollama")
        XCTAssertEqual(account.executable, "/bin/pi")
        XCTAssertEqual(ModelPicker.providers([account]).first?.title, "Pi")
        XCTAssertEqual(ModelPicker.rows(choices: account.models, defaultId: account.defaultModel, selected: nil, provider: "pi").first?.title, "Test model")
        let roundtrip = try JSONDecoder().decode(Account.self, from: JSONEncoder().encode(account))
        XCTAssertEqual(roundtrip, account)
    }
}
