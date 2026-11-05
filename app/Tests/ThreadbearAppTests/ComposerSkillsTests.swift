import AppKit
import SwiftUI
import XCTest
@testable import Threadbear
import ThreadbearCore

@MainActor
final class ComposerSkillsTests: XCTestCase {
    private var windows: [NSWindow] = []

    override func tearDown() { windows.forEach { $0.close() }; windows.removeAll(); super.tearDown() }

    private let skill = ComposerSkill(name: "deploy", description: "Ship", path: "/skills/deploy/SKILL.md", scope: "user")

    private func field(_ words: String) -> (ComposerTextView, ComposerSkillPicker) {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 200), styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        let field = ComposerTextField.makeTextView()
        window.contentView = field
        windows.append(window)
        field.replaceText(words)
        field.setSelectedRange(NSRange(location: (words as NSString).length, length: 0))
        let picker = ComposerSkillPicker()
        picker.skills = [skill]
        field.skillPicker = picker
        picker.changed(field)
        return (field, picker)
    }

    private func key(_ code: UInt16) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: code)!
    }

    func testReturnInsertsRatherThanSendingAndUndoRestoresTheCommand() {
        let (view, picker) = field("Please /dep")
        var sent = false
        view.onSend = { sent = true }
        view.keyDown(with: key(36))
        XCTAssertFalse(sent)
        XCTAssertEqual(view.string, "Please $deploy ")
        XCTAssertNil(picker.token)
        view.undoManager?.undo()
        XCTAssertEqual(view.string, "Please /dep")
        view.keyDown(with: key(36))
        XCTAssertTrue(sent)
    }

    func testEscapeDismissesUntilTheWordChanges() {
        let (view, picker) = field("/dep")
        XCTAssertTrue(picker.key(key(53), in: view))
        picker.changed(view)
        XCTAssertNil(picker.token)
        view.insertText("l", replacementRange: view.selectedRange())
        picker.changed(view)
        XCTAssertEqual(picker.token?.query, "depl")
    }

    func testSelectionPreservesTextAndPictureAttachments() {
        let (view, picker) = field("")
        let picture = ImageRef(path: "/inbox/photo.png", mediaType: "image/png")
        view.show(Draft(text: "\(InlinePictures.markString) /dep after", images: [picture]))
        view.setSelectedRange(NSRange(location: 6, length: 0))
        picker.changed(view)
        picker.choose(skill, in: view)
        XCTAssertEqual(view.draftNow, Draft(text: "\(InlinePictures.markString) $deploy  after", images: [picture]))
    }

    func testEmptyResultsDoNotSendAndArrowKeysWrap() {
        let (view, picker) = field("/nothing")
        XCTAssertTrue(picker.key(key(36), in: view))
        XCTAssertEqual(view.string, "/nothing")
        view.replaceText("/")
        view.setSelectedRange(NSRange(location: 1, length: 0))
        picker.changed(view)
        picker.skills.append(ComposerSkill(name: "audit", description: "Review", path: "/b", scope: "repo"))
        XCTAssertTrue(picker.key(key(126), in: view))
        XCTAssertEqual(picker.selected, 1)
        XCTAssertTrue(picker.key(key(125), in: view))
        XCTAssertEqual(picker.selected, 0)
    }
    func testMultiwordSearchReplacesTheEntireQuery() {
        let (view, picker) = field("Please /github create")
        picker.skills = [ComposerSkill(name: "github-create", description: "Create repository", path: "/github", scope: "user")]
        XCTAssertEqual(picker.matches.map(\.name), ["github-create"])
        view.keyDown(with: key(36))
        XCTAssertEqual(view.string, "Please $github-create ")
        picker.changed(view)
        XCTAssertNil(picker.token, "a selected dollar mention ends at its inserted space")
    }

    func testHeadroomUsesWindowCoordinatesAndTheProbeNeverTakesClicks() async throws {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
        window.contentView = content
        let probe = ComposerSkillsSpaceProbe.Probe(frame: NSRect(x: 20, y: 30, width: 460, height: 120))
        var space: CGFloat?
        probe.changed = { space = $0 }
        content.addSubview(probe)
        probe.report()
        for _ in 0..<100 where space == nil { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(try XCTUnwrap(space), max(zoomed(80), 250 - zoomed(48)), accuracy: 0.5)
        XCTAssertNil(probe.hitTest(NSPoint(x: 40, y: 40)))
        space = nil
        window.setContentSize(NSSize(width: 500, height: 260))
        probe.report()
        for _ in 0..<100 where space == nil { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(try XCTUnwrap(space), zoomed(80), accuracy: 0.5)
    }

    func testAnOldRowCannotBeChosenAfterTheSearchChanges() {
        let (view, picker) = field("/")
        view.replaceText("/github create")
        view.setSelectedRange(NSRange(location: 14, length: 0))
        picker.changed(view)
        picker.choose(skill, in: view)
        XCTAssertEqual(view.string, "/github create", "a stale deploy row must not replace the new search")
    }

    func testVisibleRowsFollowEveryCharacterWhileMenuStaysOpen() async throws {
        let (field, picker) = field("/")
        picker.skills = [
            ComposerSkill(name: "agents-sdk", description: "Build agents", path: "/a", scope: "user"),
            ComposerSkill(name: "github-create", description: "Create repository", path: "/g", scope: "user"),
            ComposerSkill(name: "usage-budget", title: "Usage budget", description: "Conserve allowance", path: "/u", scope: "user"),
        ]
        let host = NSHostingView(rootView: ComposerSkillsMenu(picker: picker, choose: { _ in }))
        let window = try XCTUnwrap(windows.last)
        window.setContentSize(NSSize(width: 700, height: 300))
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
        window.orderFrontRegardless()
        func tips(_ view: NSView) -> [String] {
            view.subviews.flatMap { ($0 as? TipAnchorView).map { $0.visibleRect.isEmpty ? [] : [$0.text] } ?? tips($0) }
        }
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(100))
        for character in "usage" {
            field.insertText(String(character), replacementRange: field.selectedRange())
            picker.changed(field)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            let shown = tips(host).filter { $0.hasPrefix("$") }
            let expected = picker.matches.map { "$\($0.name): \($0.description)\n\($0.path)" }
            XCTAssertEqual(Set(shown), Set(expected), "visible rows must follow query \(picker.token?.query ?? "")")
        }
    }

}
