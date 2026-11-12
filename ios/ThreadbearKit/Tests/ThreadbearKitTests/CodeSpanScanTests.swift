import Foundation
import Testing
@testable import ThreadbearKit

@Suite struct CodeSpanScanTests {
    @Test func scanMatchesTheOriginalRegex() {
        let pieces = ["`", "``", "```", "a", " ", "\n", "\r\n", "\r", "é", "e\u{301}", "`\u{301}", "👩🏽‍💻", "[x](work:y)"]
        var seed: UInt64 = 71
        for _ in 0..<4_000 {
            var text = ""
            for _ in 0..<16 {
                seed = seed &* 6364136223846793005 &+ 1
                text += pieces[Int((seed >> 32) % UInt64(pieces.count))]
            }
            #expect(CodeSpans.ranges(in: text, singleLine: false) == text.ranges(of: /`+[^`]*`+/), "\(text.debugDescription)")
            #expect(CodeSpans.ranges(in: text, singleLine: true) == text.ranges(of: /`+[^`\n]*`+/), "\(text.debugDescription)")
        }
    }
}
