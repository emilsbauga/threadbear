package com.mikerosoft.threadbear.kit

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean

/**
 * A command sent to the runner and waited on ([PendingCommand]), and the one
 * watcher that drives it ([PendingCommands]). Before 21 Nov each screen kept
 * its own flags and watchers: Stop just waited 30 s, and a card's answer
 * waited with no deadline.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PendingCommandTest {
    /** The transition table, against the cases the iPhone and the website run too. */
    @Test fun movesMatchTheSharedCases() {
        val file = parseJson(File("../../shared/cases/pending-commands.json").readText()) as JsonObject
        val cases = file.arr("cases")!!.map { it as JsonObject }.filter { it.obj("differs")?.containsKey("android") != true }
        assertTrue(cases.size > 20)
        for (c in cases) {
            val name = c.str("name")
            var state: PendingCommand = PendingCommand.Idle
            for (e in c.arr("input")!!.map { it as JsonObject }) {
                val at = (e.num("at") ?: 0.0).toLong()
                val event = when (e.str("event")) {
                    "tap" -> PendingCommand.Event.Tap(at)
                    "sent" -> PendingCommand.Event.Sent(e.str("id")!!, at)
                    "sendFailed" -> PendingCommand.Event.SendFailed(e.str("reason")!!)
                    "row" -> PendingCommand.Event.Row(
                        when (e.str("state")) {
                            "pending" -> CommandStatus(CommandState.PENDING)
                            "taken" -> CommandStatus(CommandState.TAKEN)
                            "done" -> CommandStatus(CommandState.DONE, threadId = e.str("threadId"))
                            "failed" -> CommandStatus(CommandState.FAILED, note = e.str("note"))
                            else -> null
                        },
                        at,
                    )
                    "deadline" -> PendingCommand.Event.Deadline(at)
                    "reconnected" -> PendingCommand.Event.Reconnected(at)
                    "cancelled" -> PendingCommand.Event.Cancelled
                    "settle" -> PendingCommand.Event.Settle
                    else -> error("$name: unknown event")
                }
                state = state.step(event)
            }
            assertEquals(c.obj("expect")!!.toMap(), describe(state), "$name: $state")
        }
    }

    /** A state as the case file writes it. */
    private fun describe(s: PendingCommand): Map<String, Any> {
        val out = mutableMapOf<String, Any>("locked" to s.locked)
        when (s) {
            PendingCommand.Idle -> out["state"] = "idle"
            is PendingCommand.Sending -> out["state"] = "sending"
            is PendingCommand.Queued -> { out["state"] = "queued"; out["id"] = s.id }
            is PendingCommand.Taken -> { out["state"] = "taken"; out["id"] = s.id }
            is PendingCommand.Done -> { out["state"] = "done"; out["id"] = s.id; s.result?.threadId?.let { out["threadId"] = it } }
            is PendingCommand.Failed -> { out["state"] = "failed"; s.id?.let { out["id"] = it }; s.reason?.let { out["reason"] = it } }
            is PendingCommand.TimedOut -> { out["state"] = "timedOut"; out["taken"] = s.taken; s.id?.let { out["id"] = it } }
        }
        return out
    }

    private fun JsonObject.toMap(): Map<String, Any> = entries.associate { (k, v) ->
        k to when {
            v is JsonPrimitive && !v.isString && (v.content == "true" || v.content == "false") -> v.boolean
            v is JsonPrimitive -> v.content
            v is JsonNull -> "null"
            else -> v.toString()
        }
    }

    @Test fun aFailureSaysItsOwnWordsWhenTheRunnerSaidNoneAndACancelSaysNothing() {
        assertEquals("Couldn't star it.", PendingCommand.Failed("c", null).failure("Couldn't star it."))
        assertEquals("gone", PendingCommand.Failed("c", "gone").failure("x"))
        assertNull(PendingCommand.Failed("c", PendingCommand.CANCELLED).failure("x"))
        assertNull(PendingCommand.TimedOut("c", false).failure("x"))
        assertEquals("Couldn't.", PendingCommand.Failed("c", " ").failure("Couldn't."))
        // A send that never reached the backend puts its change back: it may never have gone.
        assertTrue(PendingCommand.TimedOut("c", false).holdsChange)
        assertFalse(PendingCommand.TimedOut(null, false).holdsChange)
    }

    @Test fun aReplyButtonTimedOutCanBePressedAgainSayingWhy() {
        val button = MessageButton("abcd1234", "Go", "start")
        assertEquals(ReplyButtons.Look.Pressing, ReplyButtons.look(button, PendingCommand.Queued("c", 0)))
        assertEquals(ReplyButtons.Look.Pressed("t2"), ReplyButtons.look(button, PendingCommand.Done("c", CommandStatus(CommandState.DONE, threadId = "t2"))))
        assertEquals(ReplyButtons.Look.Failed("The runner couldn't press it."), ReplyButtons.look(button, PendingCommand.Failed("c", null)))
        assertIs<ReplyButtons.Look.Failed>(ReplyButtons.look(button, PendingCommand.TimedOut("c", false)))
        assertEquals(ReplyButtons.Look.Pressed("t3"), ReplyButtons.look(button.copy(pressedThreadId = "t3"), PendingCommand.TimedOut("c", false)))
    }

    // The watcher, on virtual time, against rows a fake backend writes.

    /** phone:command's rows by id, as a backend would answer them, live. */
    private class FakeRows {
        val rows = MutableStateFlow<Map<String, CommandStatus?>>(emptyMap())
        var sends = 0
        fun row(id: String): Flow<CommandStatus?> = rows.map { it[id] }
        fun send(id: String, status: CommandStatus? = CommandStatus(CommandState.PENDING)): String {
            sends++
            rows.value = rows.value + (id to status)
            return id
        }
        fun set(id: String, status: CommandStatus?) { rows.value = rows.value + (id to status) }
    }

    private fun TestScope.commands(fake: FakeRows, rows: (String) -> Flow<CommandStatus?> = fake::row) =
        PendingCommands<CommandKey>(backgroundScope, rows, now = { testScheduler.currentTime }, retryMs = 50)

    @Test fun aChangeTheRunnerDoesIsDoneThenLetGo() = runTest {
        val fake = FakeRows()
        val commands = commands(fake)
        val heard = mutableListOf<PendingCommand>()
        assertTrue(commands.start(CommandKey.Star("a1"), "on", settleMs = 1_000, send = { fake.send("c1") }, then = { heard += it }))
        assertTrue(commands[CommandKey.Star("a1")].locked)
        runCurrent()
        assertIs<PendingCommand.Queued>(commands[CommandKey.Star("a1")])
        fake.set("c1", CommandStatus(CommandState.DONE))
        runCurrent()
        assertIs<PendingCommand.Done>(commands[CommandKey.Star("a1")])
        assertEquals("on", commands.value(CommandKey.Star("a1")))
        advanceTimeBy(1_001)
        assertEquals(PendingCommand.Idle, commands[CommandKey.Star("a1")])
        assertTrue(commands.entries.value.isEmpty())
        assertEquals(1, heard.size)
    }

    @Test fun aCommandNeverTakenTimesOutStillListeningAndLandsLater() = runTest {
        val fake = FakeRows()
        val commands = commands(fake)
        val key = CommandKey.Press("a1", "b")
        val heard = mutableListOf<PendingCommand>()
        commands.start(key, send = { fake.send("c1") }, then = { heard += it })
        runCurrent()
        advanceTimeBy(PendingCommand.DEADLINE_MS + 1)
        val state = commands[key]
        assertEquals(PendingCommand.TimedOut("c1", false), state)
        assertFalse(state.locked)
        assertTrue(state.holdsChange)
        // The Mac wakes and does it: the late answer still lands.
        fake.set("c1", CommandStatus(CommandState.DONE, threadId = "t2"))
        runCurrent()
        assertEquals(PendingCommand.Done("c1", CommandStatus(CommandState.DONE, threadId = "t2")), commands[key])
        assertEquals(2, heard.size)
    }

    @Test fun aRefusedCommandFailsWithWhyAndCanBeTappedAgain() = runTest {
        val fake = FakeRows()
        val commands = commands(fake)
        val key = CommandKey.Wake("a1")
        commands.start(key, send = { fake.send("c1") })
        runCurrent()
        fake.set("c1", CommandStatus(CommandState.FAILED, note = "The thread's gone"))
        runCurrent()
        assertEquals("The thread's gone", commands[key].failure("x"))
        assertFalse(commands[key].holdsChange)
        assertTrue(commands.start(key, send = { fake.send("c2") }))
    }

    @Test fun aSendThatThrowsFails() = runTest {
        val commands = commands(FakeRows())
        commands.start(CommandKey.Stop("a1"), send = { throw TransportError.Server("expired") })
        runCurrent()
        assertEquals(PendingCommand.Failed(null, "expired"), commands[CommandKey.Stop("a1")])
    }

    @Test fun aReconnectMidWaitListensAgainOnAFreshClock() = runTest {
        val fake = FakeRows()
        // The first subscription dies with the connection; the next is on the fresh one.
        var subscriptions = 0
        val commands = commands(fake) { id ->
            subscriptions++
            if (subscriptions == 1) flow { emit(CommandStatus(CommandState.PENDING)); kotlinx.coroutines.awaitCancellation() } else fake.row(id)
        }
        val key = CommandKey.Archive("a1")
        commands.start(key, send = { fake.send("c1") })
        runCurrent()
        advanceTimeBy(15_000)
        commands.reconnected()
        runCurrent()
        // Its clock started again: not timed out at 20 s from the send.
        advanceTimeBy(6_000)
        assertIs<PendingCommand.Queued>(commands[key])
        fake.set("c1", CommandStatus(CommandState.DONE))
        runCurrent()
        assertIs<PendingCommand.Done>(commands[key])
        assertEquals(2, subscriptions)
    }

    @Test fun aDoubleTapSendsOnce() = runTest {
        val fake = FakeRows()
        val commands = commands(fake)
        val key = CommandKey.Star("a1")
        val gate = CompletableDeferred<Unit>()
        assertTrue(commands.start(key, send = { gate.await(); fake.send("c1") }))
        assertFalse(commands.start(key, send = { fake.send("c2") }))
        gate.complete(Unit)
        runCurrent()
        assertFalse(commands.start(key, send = { fake.send("c3") }))
        assertEquals(1, fake.sends)
    }

    @Test fun clearingLetsGoOfEverythingAndACancelIsQuiet() = runTest {
        val fake = FakeRows()
        val commands = commands(fake)
        commands.start(CommandKey.Card("ap1"), "allow", send = { fake.send("c1") })
        runCurrent()
        commands.cancelled(CommandKey.Card("ap1"))
        assertNull(commands[CommandKey.Card("ap1")].failure("x"))
        commands.start(CommandKey.Star("a1"), send = { fake.send("c2") })
        commands.clear()
        runCurrent()
        assertTrue(commands.entries.value.isEmpty())
    }
}
