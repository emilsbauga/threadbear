package com.mikerosoft.threadbear.kit

import com.mikerosoft.threadbear.kit.Role.ASSISTANT
import com.mikerosoft.threadbear.kit.Role.NOTE
import com.mikerosoft.threadbear.kit.Role.TOOL
import com.mikerosoft.threadbear.kit.Role.USER
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.JsonObject

/**
 * A thread whose login ran out and moved to another, or whose stopped
 * message was saved: the runner's line about it (role `note`, backend API
 * 79) shows where it happened and never folds into the work, as on the Mac
 * and the iPhone (LoginNoteTests in TurnsTests.swift, the same cases).
 */
class LoginNoteTest {
    private val moved = "Moved to alex@example.org: alex@example.net hit its 5-hour limit, back at 11:30 am."

    private fun shown(items: List<ThreadItem>) = items.map { item ->
        when (item) {
            is ThreadItem.Message -> "${item.message.role.name.lowercase()}:${item.message.text}"
            is ThreadItem.Note -> "note:${item.message.text}"
            is ThreadItem.Tools -> "tools"
            is ThreadItem.Worked -> "worked"
            is ThreadItem.Gap -> "gap"
        }
    }

    @Test fun aNoteStaysOutOfTheWorkBetweenWhatCameBeforeAndTheReplyAfter() {
        val rows = listOf(
            msg(1, USER, "land it", 0.0),
            msg(2, TOOL, "Ran tb land", 5.0),
            msg(3, ASSISTANT, "You've hit your 5-hour limit", 60.0, turn = "aaaa1111"),
            msg(4, NOTE, moved, 61.0),
            msg(5, USER, "Carry on from where you left off.", 62.0, origin = "runner", turn = "bbbb2222"),
            msg(6, TOOL, "Ran git push", 70.0, turn = "bbbb2222"),
            msg(7, ASSISTANT, "Landed.", 90.0, turn = "bbbb2222"),
        )
        val without = shown(Turns.fold(rows.filter { it.role != NOTE }, busy = false))
        val with = shown(Turns.fold(rows, busy = false))
        assertEquals(without, with.filter { !it.startsWith("note:") })
        assertEquals("assistant:Landed.", with.last())
        assertEquals("note:$moved", with.dropLast(1).last())
    }

    /** The login ran out before the turn did anything: the note still goes under the limit's words. */
    @Test fun aLimitHitBeforeAnyWorkKeepsTheNoteUnderIt() {
        val rows = listOf(
            msg(1, USER, "fix it", 0.0),
            msg(2, ASSISTANT, "You've hit your limit", 1.0, turn = "aaaa1111"),
            msg(3, NOTE, moved, 2.0),
            msg(4, USER, "Carry on.", 3.0, origin = "runner", turn = "bbbb2222"),
            msg(5, TOOL, "Edited a file", 4.0, turn = "bbbb2222"),
            msg(6, ASSISTANT, "Fixed.", 9.0, turn = "bbbb2222"),
        )
        assertEquals(
            listOf("user:fix it", "worked", "assistant:You've hit your limit", "note:$moved", "assistant:Fixed."),
            shown(Turns.fold(rows, busy = false)),
        )
    }

    @Test fun aThreadWaitingForRoomEndsOnItsNote() {
        val wait = "Every login in Claude is out of room. Carrying on at 11:30 am."
        val rows = listOf(msg(1, USER, "land it", 0.0), msg(2, TOOL, "Ran tb land", 5.0), msg(3, ASSISTANT, "You've hit your 5-hour limit", 60.0), msg(4, NOTE, wait, 61.0))
        assertEquals("note:$wait", shown(Turns.fold(rows, busy = false)).last())
        // The done card and the reply's buttons go by the last thing said, which isn't the note.
        assertEquals(3, Turns.lastShown(rows)?.seq)
    }

    @Test fun aRunningTurnShowsItInPlace() {
        val rows = listOf(msg(1, USER, "go", 0.0), msg(2, TOOL, "Read a", 1.0), msg(3, NOTE, moved, 2.0), msg(4, ASSISTANT, "So far", 3.0))
        assertEquals(listOf("user:go", "tools", "note:$moved", "assistant:So far"), shown(Turns.fold(rows, busy = true)))
    }

    /** The parity scenario: a message saved after Stop goes between the two messages, never folded. */
    @Test fun aSavedMessageNoteSitsBetweenTheTwoMessages() {
        val saved = "Your stopped message and pictures are saved for your next message."
        val rows = listOf(
            msg(1, USER, "Start", 0.0), msg(2, ASSISTANT, "Ready.", 1.0),
            msg(3, USER, "Please fix the spot in this picture.", 2.0), msg(4, NOTE, saved, 3.0),
            msg(5, USER, "Continuing on another model.", 4.0), msg(6, ASSISTANT, "I can fix the spot.", 5.0),
        )
        assertEquals(
            listOf("user:Start", "assistant:Ready.", "user:Please fix the spot in this picture.", "note:$saved", "user:Continuing on another model.", "assistant:I can fix the spot."),
            shown(Turns.fold(rows, busy = false)),
        )
    }

    @Test fun aPageWithANoteDecodes() {
        val json = """{"messages":[{"seq":1,"role":"user","text":"Fix it","at":1762650000000},{"seq":2,"role":"note","text":"Moved to a: b hit its 5-hour limit.","at":1762650001000}],"hasMore":false}"""
        val page = MessagePage.read(parseJson(json) as JsonObject)
        assertEquals(listOf(USER, NOTE), page.messages.map { it.role })
    }
}
