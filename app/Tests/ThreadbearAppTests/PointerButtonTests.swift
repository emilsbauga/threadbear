import AppKit
import XCTest
@testable import Threadbear

/// The done card's "?" sits over the card's text, whose tracking area still
/// fires under it, and NSTextView answers with its I-beam. The rest of what
/// took the hand away (AppKit working the cursor out again when a tip comes
/// up or a click redraws the card) only happens with a real pointer, so
/// `PointerButton.cursorWatch` isn't covered here: see "A cursor bug" in
/// desktop/README.md for how it was checked.
@MainActor
final class PointerButtonTests: XCTestCase {
    private func moved(_ point: NSPoint, in window: NSWindow) -> NSEvent {
        NSEvent.mouseEvent(with: .mouseMoved, location: point, modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                           context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
    }

    private func card() -> (NSWindow, TranscriptTextView, PointerButton) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 200))
        window.contentView = root
        let text = TranscriptTextView(frame: root.bounds)
        text.string = "A follow-up on the done card"
        root.addSubview(text)
        let button = PointerButton(frame: NSRect(x: 360, y: 100, width: 22, height: 22))
        root.addSubview(button)
        return (window, text, button)
    }

    func testTheTextUnderTheButtonShowsTheHand() {
        let (window, text, _) = card()
        let over = moved(NSPoint(x: 370, y: 110), in: window)
        NSCursor.arrow.set()
        text.mouseMoved(with: over)
        XCTAssertEqual(NSCursor.current, .pointingHand)
        NSCursor.arrow.set()
        text.cursorUpdate(with: over)
        XCTAssertEqual(NSCursor.current, .pointingHand)
        NSCursor.arrow.set()
        text.mouseEntered(with: over)
        XCTAssertEqual(NSCursor.current, .pointingHand)
    }

    func testOnlyAShownButtonUnderThePointerCounts() {
        let (window, _, button) = card()
        XCTAssertTrue(PointerButton.isUnderPointer(in: window, at: NSPoint(x: 370, y: 110)))
        XCTAssertFalse(PointerButton.isUnderPointer(in: window, at: NSPoint(x: 100, y: 110)))
        button.isHidden = true
        XCTAssertFalse(PointerButton.isUnderPointer(in: window, at: NSPoint(x: 370, y: 110)))
    }
}
