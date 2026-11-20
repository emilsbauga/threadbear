import Foundation
import Testing
@testable import ThreadbearKit

struct DesignReviewsTests {
    private func review() throws -> PhoneDesignReview {
        try JSONDecoder().decode(PhoneDesignReview.self, from: Data(#"{"id":"r","title":"Layout","status":"pending","revision":0,"recommended":"A","draft":{"notes":{}},"options":[{"id":"A","title":"First","shots":[{"src":"review:r:a","kind":"page"}]},{"id":"B","title":"Today","reference":true,"shots":[]}]}"#.utf8))
    }

    @Test func selectionAndNoneAreExclusive() throws {
        let review = try review()
        var draft = DesignReviewDraft()
        #expect(!draft.canSend(to: review))
        draft.pick("A", selected: true)
        #expect(draft.canSend(to: review))
        draft.pickNone(true)
        #expect(draft.picks.isEmpty)
        #expect(draft.canSend(to: review))
        draft.pick("A", selected: true)
        #expect(draft.none == nil)
        draft.pick("B", selected: true)
        #expect(!draft.canSend(to: review))
    }

    @Test func notesAndReadOnlyReviews() throws {
        var review = try review()
        var draft = DesignReviewDraft()
        draft.notes["B"] = "Keep this spacing"
        #expect(draft.canSend(to: review))
        review.status = "answered"
        #expect(!draft.canSend(to: review))
        review.status = "pending"
        draft.reply = String(repeating: "x", count: 8001)
        #expect(!draft.canSend(to: review))
    }

    @Test func reviewCommandResultsDecodeWithoutBreakingSlashCommands() throws {
        let status = try JSONDecoder().decode(CommandStatus.self, from: Data(#"{"state":"done","result":{"reviews":[{"id":"r","title":"Layout"}]}}"#.utf8))
        #expect(status.designReviews?.reviews?.first?.id == "r")
        #expect(status.commands == nil)
    }

    @Test func notesGoAsAListSoAnyOptionIdIsSafe() throws {
        var draft = DesignReviewDraft()
        draft.notes["$weird"] = "first"
        draft.notes["Café"] = "second"
        guard case let .object(args) = draft.arguments, case let .array(notes)? = args["notes"] else {
            Issue.record("notes aren't a list"); return
        }
        #expect(notes == [
            .object(["id": .string("$weird"), "text": .string("first")]),
            .object(["id": .string("Café"), "text": .string("second")]),
        ])
    }

    @Test func aStillWithNoPreviewSaysSo() throws {
        let review = try JSONDecoder().decode(PhoneDesignReview.self, from: Data(#"{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{}},"options":[{"id":"A","title":"A","shots":[{"src":"review:r:a","kind":"image","preview":false},{"src":"review:r:b","kind":"image"}]}]}"#.utf8))
        #expect(review.options[0].shots.map(\.preview) == [false, nil])
    }

    @Test func aReviewComesAsJSONTextWithAnyNoteKeys() throws {
        let inner = #"{"review":{"id":"r","title":"T","status":"pending","revision":0,"draft":{"notes":{"Café":"tighter","$odd":"x"}},"options":[]}}"#
        let outer = try JSONEncoder().encode(["state": "done", "result": inner])
        let status = try JSONDecoder().decode(CommandStatus.self, from: outer)
        #expect(status.designReviews?.review?.draft.notes["Café"] == "tighter")
        #expect(status.designReviews?.review?.draft.notes["$odd"] == "x")
        #expect(status.commands == nil)
    }
}
