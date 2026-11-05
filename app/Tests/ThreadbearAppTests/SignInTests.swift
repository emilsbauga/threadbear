import XCTest
import ThreadbearCore
@testable import Threadbear

final class SignInTests: XCTestCase {
    func testPiUsesOnlyItsOwnExecutableProfileAndProvider() {
        let account = Account(id: "pi:local", provider: "pi", title: "Local", configDir: "/profiles/pi", executable: "/bin/pi", connection: PiModelConnection(provider: "openrouter", model: "model"))
        let script = SignIn.script(account, cliPath: "/bin/codex")
        XCTAssertTrue(script.contains("In Pi, run /login openrouter to sign in."), script)
        XCTAssertTrue(script.contains("PI_CODING_AGENT_DIR='/profiles/pi' '/bin/pi' --no-tools --no-extensions --no-mcp --no-skills --no-context-files"), script)
        XCTAssertFalse(script.contains("auth login"))
        XCTAssertFalse(script.contains("codex"))
        XCTAssertFalse(script.contains("CLAUDE_CONFIG_DIR"))
    }
    // claude-main is the Keychain login the runner starts with no
    // CLAUDE_CONFIG_DIR, so its sign-in mustn't set one either.
    func testMainClaudeLoginSetsNoConfigDir() {
        let script = SignIn.script(Account(id: "claude-main", provider: "claude", title: "me@example.com", configDir: "/Users/x/.claude"), cliPath: "/Users/x/.local/bin/claude")
        XCTAssertTrue(script.contains("\n'/Users/x/.local/bin/claude' auth login\n"), script)
        XCTAssertFalse(script.contains("CLAUDE_CONFIG_DIR"))
    }

    func testOtherClaudeLoginUsesItsFolder() {
        let script = SignIn.script(Account(id: "claude-1", provider: "claude", title: "two", configDir: "/Users/x/Library/Application Support/Threadbear/accounts/claude-1"), cliPath: "")
        XCTAssertTrue(script.contains("CLAUDE_CONFIG_DIR='/Users/x/Library/Application Support/Threadbear/accounts/claude-1' claude auth login"), script)
    }

    func testCodexUsesCodexHomeAndQuotes() {
        let script = SignIn.script(Account(id: "codex-1", provider: "codex", title: "c", configDir: "/tmp/it's here"), cliPath: "/opt/codex")
        XCTAssertTrue(script.contains("CODEX_HOME='/tmp/it'\\''s here' '/opt/codex' login"), script)
    }

    func testScriptRunsInZsh() throws {
        let script = SignIn.script(Account(id: "codex-1", provider: "codex", title: "c", configDir: "/tmp/it's here"), cliPath: "/bin/echo")
        XCTAssertTrue(script.hasPrefix("#!/bin/zsh -l\n"))
        // zsh parses it (the quoting holds), without running anything.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-n", "-c", script]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
    }
}
