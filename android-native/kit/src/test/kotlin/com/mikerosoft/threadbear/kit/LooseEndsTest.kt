package com.mikerosoft.threadbear.kit

import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject

/**
 * The done card's loose ends (AsksCard.swift's DoneCard, the Mac's
 * LooseEnd): what's still open first, under "Still open", or only booked
 * check-ins under "Coming back", each with its time.
 */
class LooseEndsTest {
    private val perth = ZoneId.of("Australia/Perth")

    @Test fun aBookedCheckInSaysWhenItComesBack() {
        val end = PhoneLooseEnd("scheduled", "Look at how the experiment went", at = "2026-11-15T01:30:00.000Z")
        assertTrue(end.isBooked)
        assertEquals("Sun 15 Nov, 9:30 am: Look at how the experiment went", LooseEnds.line(end, perth))
        assertEquals("Sun 15 Nov, 1:30 am: Look at how the experiment went", LooseEnds.line(end, ZoneId.of("UTC")))
        assertEquals("Coming back", LooseEnds.heading(listOf(end)))
        // Without milliseconds too, and its text when the time doesn't read.
        assertEquals("Sun 15 Nov, 2:05 pm: x", LooseEnds.line(PhoneLooseEnd("scheduled", "x", at = "2026-11-15T06:05:00Z"), perth))
        // With an offset, as the iPhone's ISO8601DateFormatter and the website read it.
        assertEquals("Sun 15 Nov, 9:30 am: x", LooseEnds.line(PhoneLooseEnd("scheduled", "x", at = "2026-11-15T09:30:00+08:00"), perth))
        assertEquals("x", LooseEnds.line(PhoneLooseEnd("scheduled", "x", at = "soon"), perth))
        assertEquals("x", LooseEnds.line(PhoneLooseEnd("scheduled", "x"), perth))
    }

    @Test fun openOnesGoFirstUnderStillOpen() {
        val booked = PhoneLooseEnd("scheduled", "Check in", at = "2026-11-15T01:30:00.000Z")
        val branch = PhoneLooseEnd("uncommitted", "2 files it changed in api aren't committed")
        val thread = PhoneLooseEnd("thread", "A thread it started is still going", threadId = "th-2")
        val ordered = LooseEnds.ordered(listOf(booked, branch, thread))
        assertEquals(listOf(branch, thread, booked), ordered)
        assertEquals("Still open", LooseEnds.heading(ordered))
        assertFalse(branch.isBooked)
        // A line that isn't a check-in is its text, whatever its time.
        assertEquals("2 files it changed in api aren't committed", LooseEnds.line(branch, perth))
        assertNull(LooseEnds.heading(emptyList()))
    }

    @Test fun aThreadRowCarriesItsLooseEndsAndSkipsOddOnes() {
        val row = """{"threadId":"t","runnerId":"mac","title":"t","cwd":"/x","accountId":"a","provider":"claude","status":"idle","needsYou":false,
            "unread":false,"preview":"","lastActivityAt":0,
            "looseEnds":[{"kind":"thread","text":"A thread it started is still going","threadId":"th-2"},7,{"kind":"scheduled","text":"Check","at":"2026-11-15T01:30:00.000Z"}]}"""
        val t = PhoneThread.read(parseJson(row) as JsonObject)
        assertEquals(listOf("thread", "scheduled"), t.looseEnds?.map { it.kind })
        assertEquals("th-2", t.looseEnds?.first()?.threadId)
        assertEquals("2026-11-15T01:30:00.000Z", t.looseEnds?.last()?.at)
        val none = PhoneThread.read(parseJson(row.replace("\"looseEnds\"", "\"other\"")) as JsonObject)
        assertNull(none.looseEnds)
    }
}
