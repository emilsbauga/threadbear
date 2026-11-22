package com.mikerosoft.threadbear.kit

import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/**
 * One of the done card's loose ends, as the Mac's LooseEnd (the iPhone's
 * PhoneLooseEnd): a branch not on main, files not committed or pushed, a
 * thread it started that's still going, a booked check-in, or the agent's
 * own word. A kind this phone doesn't know shows as its text.
 */
data class PhoneLooseEnd(
    val kind: String,
    val text: String,
    /** The thread it's about (kind thread): its line opens it. */
    val threadId: String? = null,
    /** When a booked check-in runs (kind scheduled), ISO. */
    val at: String? = null,
) {
    /** A booked check-in: the thread comes back by itself when it runs. */
    val isBooked get() = kind == "scheduled"

    companion object {
        /** Lenient, so one odd entry can't lose the whole thread row. */
        fun read(o: JsonObject) = PhoneLooseEnd(o.str("kind") ?: "", o.str("text") ?: "", o.str("threadId"), o.str("at"))
    }
}

/** The done card's loose ends as the iPhone's DoneCard lists them. */
object LooseEnds {
    /** Open ones first, then the check-ins. */
    fun ordered(ends: List<PhoneLooseEnd>): List<PhoneLooseEnd> = ends.filter { !it.isBooked } + ends.filter { it.isBooked }

    /** "Still open" while anything is, "Coming back" for only booked check-ins; null for none. */
    fun heading(ends: List<PhoneLooseEnd>): String? = when {
        ends.isEmpty() -> null
        ends.any { !it.isBooked } -> "Still open"
        else -> "Coming back"
    }

    private val day = DateTimeFormatter.ofPattern("EEE d MMM, h:mm", Locale.UK)

    /** "Sun 15 Nov, 9:30 am: the check-in" for a booked one, as the Mac says it; else its text. */
    fun line(end: PhoneLooseEnd, zone: ZoneId = ZoneId.systemDefault()): String {
        if (!end.isBooked) return end.text
        val at = end.at?.let { runCatching { Instant.parse(it) }.recoverCatching { _ -> OffsetDateTime.parse(it).toInstant() }.getOrNull() } ?: return end.text
        val local = at.atZone(zone)
        return "${day.format(local)} ${if (local.hour < 12) "am" else "pm"}: ${end.text}"
    }
}
