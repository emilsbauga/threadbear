import AppKit
import DesktopGuard
import XCTest

@MainActor
final class DesktopGuardTests: XCTestCase {
    func testOrderedWindowsRemainInvisibleAndIgnoreDesktopClicks() throws {
        // Refuse to open anything if the early installer wasn't linked.
        XCTAssertTrue(TBDesktopGuardInstalled(), "the test bundle must install protection before any test")
        guard TBDesktopGuardInstalled() else { return }
        _ = NSApplication.shared
        for frontRegardless in [false, true] {
            let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 300),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            defer { window.close() }
            window.contentView = NSView()
            window.alphaValue = 1
            window.ignoresMouseEvents = false
            if frontRegardless { window.orderFrontRegardless() }
            else { window.makeKeyAndOrderFront(nil) }
            XCTAssertTrue(window.isVisible, "AppKit still lays out and dispatches direct test events")
            XCTAssertEqual(window.alphaValue, 0)
            XCTAssertTrue(window.ignoresMouseEvents)
            XCTAssertFalse(window.hasShadow)
            XCTAssertLessThan(window.level.rawValue, NSWindow.Level.normal.rawValue)
            // A later presentation mustn't undo the protection.
            window.alphaValue = 1
            window.ignoresMouseEvents = false
            XCTAssertEqual(window.alphaValue, 0)
            XCTAssertTrue(window.ignoresMouseEvents)
            let listed = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? []
            for entry in listed where (entry[kCGWindowNumber as String] as? Int) == window.windowNumber {
                XCTAssertEqual(entry[kCGWindowAlpha as String] as? Double, 0)
            }
        }
    }
}
