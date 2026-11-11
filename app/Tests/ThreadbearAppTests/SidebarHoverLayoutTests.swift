import AppKit
import SwiftUI
import XCTest
import ThreadbearCore
@testable import Threadbear

@MainActor
final class SidebarHoverLayoutTests: XCTestCase {
    func testHoverActionsKeepTheRowsHeight() {
        let app = AppModel()
        var thread = ThreadSummary(id: "hover-layout", title: "Investigate the repeated panel layout freeze")
        thread.cwd = "/Users/example/Projects/threadbear"
        thread.lastActivityAt = Date().addingTimeInterval(-3720)
        for status in [ThreadStatus.idle, .running, .waiting, .error] {
            thread.status = status
            for width: CGFloat in [220, 280, 360] {
                let view = NSHostingView(rootView: ThreadRowView(thread: thread, mode: .inbox, section: .inbox, select: {}).environment(app).frame(width: width))
                app.hoverOverride = "another-row"
                view.layoutSubtreeIfNeeded()
                let resting = view.fittingSize.height
                app.hoverOverride = thread.id
                view.layoutSubtreeIfNeeded()
                XCTAssertEqual(view.fittingSize.height, resting, accuracy: 0.1, "Hover must not move a stationary pointer across a row boundary: \(status), width \(width)")
                app.hoverOverride = "another-row"
                view.layoutSubtreeIfNeeded()
                XCTAssertEqual(view.fittingSize.height, resting, accuracy: 0.1)
            }
        }
    }

    func testAPointerNearTheRowsLowerEdgeDoesNotToggleHoverRepeatedly() {
        let app = AppModel()
        let thread = ThreadSummary(id: "hover-edge", title: "Investigate the freeze", status: .running)
        app.hoverOverride = "another-row"
        let view = NSHostingView(rootView: ThreadRowView(thread: thread, mode: .inbox, section: .inbox, select: {}).environment(app).frame(width: 220))
        view.layoutSubtreeIfNeeded()
        let pointerY = view.fittingSize.height - 1
        var hovered = false
        var crossings = 0
        // Feed each measured hit region back into hover, as a stationary
        // pointer at the lower edge does when layout changes beneath it.
        for _ in 0..<8 {
            let inside = pointerY < view.fittingSize.height
            if inside != hovered { crossings += 1 }
            hovered = inside
            app.hoverOverride = inside ? thread.id : "another-row"
            view.layoutSubtreeIfNeeded()
        }
        XCTAssertEqual(crossings, 1, "The pointer should enter once and stay inside")
        XCTAssertTrue(hovered)
    }
}
