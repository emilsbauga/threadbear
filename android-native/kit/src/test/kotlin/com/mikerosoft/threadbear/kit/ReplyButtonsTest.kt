package com.mikerosoft.threadbear.kit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Reply buttons (docs/protocol/events.md, "Reply buttons"): a daily brief's `[Fill in the form](button:<id>)` drawn as a button that starts a thread. */
class ReplyButtonsTest {
    private val start = MessageButton("abcd1234", "Fill in the form", "start", target = "pebble")

    @Test fun aButtonLinkIsATarget() {
        assertEquals(ThreadLinks.Target.Button("abcd1234"), ThreadLinks.target("button:abcd1234"))
        assertNull(ThreadLinks.target("button:"))
    }

    @Test fun buttonsAtTheEndOfALineArePeeledOff() {
        val line = "The Pebble form is due Friday. [Fill in the form](button:abcd1234) · [Not now](button:efgh5678)"
        val split = ReplyButtons.trailing(line)
        assertEquals("The Pebble form is due Friday.", split.text)
        assertEquals(listOf(ReplyButtons.Link("abcd1234", "Fill in the form"), ReplyButtons.Link("efgh5678", "Not now")), split.links)
    }

    @Test fun aButtonWithWordsAfterItStaysInTheText() {
        assertTrue(ReplyButtons.trailing("Press [Go](button:abcd1234) when you're ready.").links.isEmpty())
        assertEquals("No buttons here.", ReplyButtons.trailing("No buttons here.").text)
    }

    @Test fun aButtonTheRowDoesNotCarryIsItsTitle() {
        val text = "[Go](button:abcd1234) and [Old](button:zzzz0000) and [web](https://x.y)"
        assertEquals("[Go](button:abcd1234) and Old and [web](https://x.y)", ReplyButtons.unlinking(text, setOf("abcd1234")))
        assertEquals("Go and Old and [web](https://x.y)", ReplyButtons.unlinking(text, emptySet()))
    }

    @Test fun aPressShowsAsPressingThenPressed() {
        assertEquals(ReplyButtons.Look.Ready, ReplyButtons.look(start, null, asking = false))
        assertEquals(ReplyButtons.Look.Pressing, ReplyButtons.look(start, null, asking = true))
        assertEquals(ReplyButtons.Look.Pressing, ReplyButtons.look(start, CommandStatus(CommandState.TAKEN), asking = false))
        assertEquals(ReplyButtons.Look.Pressed("t2"), ReplyButtons.look(start, CommandStatus(CommandState.DONE, threadId = "t2"), asking = false))
    }

    @Test fun theRowSayingPressedWinsAndAFailureCanBePressedAgain() {
        val pressed = start.copy(pressedThreadId = "t3")
        assertEquals(ReplyButtons.Look.Pressed("t3"), ReplyButtons.look(pressed, CommandStatus(CommandState.FAILED, note = "x"), asking = false))
        assertEquals(ReplyButtons.Look.Failed("Folder not found"), ReplyButtons.look(start, CommandStatus(CommandState.FAILED, note = "Folder not found"), asking = false))
        assertEquals(ReplyButtons.Look.Failed("gone"), ReplyButtons.look(start.copy(failed = "gone"), null, asking = false))
    }

    @Test fun aRowDecodesItsButtonsAndAnOldRowHasNone() {
        val json = """{"seq":4.0,"role":"assistant","text":"x","buttons":[{"id":"abcd1234","title":"Go","kind":"send","target":"Meetup","pressedThreadId":"t9"}],"at":"2026-11-07T00:00:00.000Z"}"""
        val m = PhoneMessage.read(parseJson(json) as JsonObject)
        assertEquals(listOf(MessageButton("abcd1234", "Go", "send", "Meetup", "t9")), m.buttons)
        val old = PhoneMessage.read(parseJson("""{"seq":4,"role":"assistant","text":"x","at":"2026-11-07T00:00:00.000Z"}""") as JsonObject)
        assertNull(old.buttons)
    }

    @Test fun hintsSayWhereItGoes() {
        assertEquals("Starts a thread in pebble", ReplyButtons.hint(start))
        assertEquals("Sends a message", ReplyButtons.hint(MessageButton("x", "y", "send")))
    }

    /** A shared case file's cases this app runs: those whose `differs` doesn't name Android. */
    private fun shared(path: String): List<JsonObject> =
        (parseJson(File(path).readText()) as JsonObject).arr("cases")!!.map { it as JsonObject }.filter { it.obj("differs")?.containsKey("android") != true }

    /** How a button looks, against the cases the desktop app, the iPhone and the website run too. */
    @Test fun looksMatchTheSharedCases() {
        val cases = shared("../../shared/cases/reply-buttons.json")
        assertTrue(cases.size > 5)
        for (c in cases) {
            val name = c.str("name")
            val input = c.obj("input")!!
            val row = input.obj("button")!!
            val press = input.obj("press")!!
            val expect = c.obj("expect")!!
            val button = MessageButton("abcd1234", "Go", row.str("kind")!!, target = row.str("target"), pressedThreadId = row.str("pressedThreadId"), failed = row.str("failed"))
            val state = press.str("state")!!
            val status = if (state == "none" || state == "sending") null else CommandStatus(CommandState.valueOf(state.uppercase()), note = press.str("note"), threadId = press.str("threadId"))
            val want = when (expect.str("look")) {
                "pressed" -> ReplyButtons.Look.Pressed(expect.str("threadId"))
                "failed" -> ReplyButtons.Look.Failed(expect.str("error")!!)
                "pressing" -> ReplyButtons.Look.Pressing
                else -> ReplyButtons.Look.Ready
            }
            assertEquals(want, ReplyButtons.look(button, status, asking = state == "sending"), name)
        }
    }

    /** Button links as text, against the cases the desktop app and the iPhone run too. */
    @Test fun buttonLinksMatchTheSharedCases() {
        val cases = shared("../../shared/cases/reply-button-links.json")
        assertTrue(cases.size > 5)
        for (c in cases) {
            val name = c.str("name")
            val input = c.obj("input")!!
            val expect = c.obj("expect")!!
            val text = input.str("text")!!
            if (input.str("op") == "unlink") {
                val known = input.arr("known")!!.map { (it as JsonPrimitive).content }.toSet()
                assertEquals(expect.str("text"), ReplyButtons.unlinking(text, known), name)
            } else {
                val split = ReplyButtons.trailing(text)
                assertEquals(expect.str("text"), split.text, name)
                val links = expect.arr("links")!!.map { val l = it as JsonObject; ReplyButtons.Link(l.str("id")!!, l.str("title")!!) }
                assertEquals(links, split.links, name)
            }
        }
    }
}
