package com.mikerosoft.threadbear.kit

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * Another lab's review on the phone (LabReviewTests.swift), worded as the
 * Mac's row and the website say it, and never in the way of the thread
 * loading.
 */
class LabReviewTest {
    private val ledger = PhoneLabReview(
        reviewer = "Codex (codex-1)",
        findings = listOf(
            PhoneReviewFinding(1, "high", "Drops the session on refresh.", where = "src/app.ts:3", outcome = "fixed"),
            PhoneReviewFinding(2, "low", "Logs the token.", outcome = "disputed", note = "It logs a hash."),
        ),
    )

    @Test fun headingSaysWhoAndHowItCameOut() {
        assertEquals("Reviewed by Codex: all answered", LabReviewText.heading(ledger))
        val open = ledger.copy(rounds = 2, findings = listOf(ledger.findings[0].copy(outcome = null), ledger.findings[1]))
        assertEquals("Reviewed by Codex, 2 rounds: 1 open", LabReviewText.heading(open))
        assertEquals("Reviewed by Codex: nothing found", LabReviewText.heading(PhoneLabReview("Codex", passed = true, findings = emptyList())))
        assertEquals("Reviewed by a fresh Claude session: passed", LabReviewText.heading(PhoneLabReview("Claude", independent = false, passed = true, findings = ledger.findings)))
        assertEquals("Reviewed by Codex: see its reply", LabReviewText.heading(ledger.copy(unstructured = true)))
        assertEquals("Reviewed by Codex: last fixes not re-reviewed", LabReviewText.heading(ledger.copy(unchecked = true)))
    }

    @Test fun findingLineSaysWhatWasDone() {
        assertEquals("Fixed · serious · src/app.ts:3", LabReviewText.detail(ledger.findings[0]))
        assertEquals("Disputed: It logs a hash.", LabReviewText.detail(ledger.findings[1]))
        assertEquals(LabReviewText.Outcome.FIXED, LabReviewText.outcome(ledger.findings[0]))
        assertEquals(LabReviewText.Outcome.LEFT, LabReviewText.outcome(ledger.findings[0].copy(outcome = "left")))
        assertEquals("Left for you", LabReviewText.detail(ledger.findings[0].copy(outcome = "left", severity = "low", where = null)))
        assertEquals("No answer", LabReviewText.detail(ledger.findings[0].copy(outcome = "later", severity = "low", where = "")))
    }

    @Test fun decodesFromTheRowAndShrugsOffOddShapes() {
        val json = """
            {"reviewer":"Codex (codex-1)","independent":true,"rounds":1,"threadId":"r1","passed":false,
             "findings":[{"id":1,"round":1,"severity":"high","claim":"Drops the session.","outcome":"fixed"},{"id":"bad"},{"id":2,"round":1,"severity":"low","claim":"Logs the token.","later":true}],
             "somethingNew":42}
        """
        val r = PhoneLabReview.read(parseJson(json) as JsonObject)
        assertEquals(listOf("Drops the session.", "Logs the token."), r.findings.map { it.claim })
        assertEquals("r1", r.threadId)
        val odd = PhoneLabReview.read(parseJson("""{"rounds":"two"}""") as JsonObject)
        assertTrue(odd.findings.isEmpty())
        assertEquals(1, odd.rounds)
        assertEquals("Another lab", odd.reviewer)
    }

    /** Another runner writes these rows: a number out of range is left out or taken as one, never a crash. */
    @Test fun numbersOutOfRangeNeverStopTheApp() {
        for (bad in listOf("1e20", "-1e20", "1.5", "-3", "9223372036854775808", "1.7976931348623157e308")) {
            val json = """[{"reviewer":"Codex","rounds":$bad,"findings":[{"id":$bad,"claim":"Odd."},{"id":2,"claim":"Fine."}]}]"""
            val rows = (parseJson(json) as JsonArray).lossy { PhoneLabReview.read(it as JsonObject) }
            assertEquals(1, rows.size, bad)
            assertEquals(1, rows[0].rounds, bad)
            assertEquals(listOf(2), rows[0].findings.map { it.id }, bad)
        }
    }

    @Test fun goesOverItsOwnTurnsReplyOnly() {
        val messages = listOf(
            msg(1, Role.USER, "Fix it", 0.0, turn = "aaaa1111"),
            msg(3, Role.ASSISTANT, "On it.", 1.0, turn = "aaaa1111"),
            msg(5, Role.ASSISTANT, "Fixed it.", 2.0, turn = "aaaa1111"),
            msg(7, Role.USER, "Again", 3.0, turn = "bbbb2222"),
        )
        assertEquals(5, LabReviewText.replySeq(messages, "aaaa1111"))
        assertNull(LabReviewText.replySeq(messages, "bbbb2222"))
        assertNull(LabReviewText.replySeq(messages, null))
    }

    @Test fun aThreadRowCarriesItsReviewAndTurn() {
        val row = """{"threadId":"t","runnerId":"mac","title":"t","cwd":"/x","accountId":"a","provider":"claude","status":"idle","needsYou":false,
            "unread":false,"preview":"","lastActivityAt":0,"cardTurn":"abcd1234",
            "review":{"reviewer":"Codex","passed":true,"rounds":2,"findings":[{"id":1,"claim":"The cap can be skipped"}]}}"""
        val t = PhoneThread.read(parseJson(row) as JsonObject)
        assertEquals("abcd1234", t.cardTurn)
        assertEquals(2, t.review?.rounds)
        assertEquals("The cap can be skipped", t.review?.findings?.single()?.claim)
        // A review that isn't an object leaves the thread loading.
        val bad = PhoneThread.read(parseJson(row.replace(""""review":{""", """"review":7,"x":{""")) as JsonObject)
        assertNull(bad.review)
    }
}
