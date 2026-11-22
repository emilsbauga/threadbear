package com.mikerosoft.threadbear.kit

import kotlinx.serialization.json.JsonObject

/**
 * Another lab's review of a turn's change (docs/protocol/needs-you.md,
 * "Review by another lab"): the thread row's `review` (backend API 76), for
 * the turn its `cardTurn` names. Read leniently, field by field, as the
 * iPhone's PhoneLabReview, so a ledger in a shape this phone doesn't know
 * never stops the thread loading.
 */
data class PhoneLabReview(
    val reviewer: String,
    val independent: Boolean = true,
    val rounds: Int = 1,
    val threadId: String = "",
    val passed: Boolean = false,
    val unstructured: Boolean? = null,
    val unchecked: Boolean? = null,
    val findings: List<PhoneReviewFinding>,
) {
    companion object {
        fun read(o: JsonObject) = PhoneLabReview(
            reviewer = o.str("reviewer") ?: "Another lab",
            independent = o.bool("independent") ?: true,
            // Another runner writes it: a count of rounds or one.
            rounds = o.num("rounds")?.wholeCount() ?: 1,
            threadId = o.str("threadId") ?: "",
            passed = o.bool("passed") ?: false,
            unstructured = o.bool("unstructured"),
            unchecked = o.bool("unchecked"),
            findings = o.arr("findings")?.lossy { PhoneReviewFinding.read(it as JsonObject) } ?: emptyList(),
        )
    }
}

data class PhoneReviewFinding(
    val id: Int,
    val severity: String = "medium",
    val claim: String,
    val where: String? = null,
    val outcome: String? = null,
    val note: String? = null,
) {
    companion object {
        /** A finding whose id isn't a whole number, or with no claim, is left out. */
        fun read(o: JsonObject) = PhoneReviewFinding(
            id = o.needNum("id").wholeCount() ?: throw BadRow("Not a whole number"),
            severity = o.str("severity") ?: "medium",
            claim = o.needStr("claim"),
            where = o.str("where"),
            outcome = o.str("outcome"),
            note = o.str("note"),
        )
    }
}

/**
 * The review's words, as the Mac's row says them (desktop/core
 * LabReview::heading, rows/lab_review.rs), the website's (lab-review.ts)
 * and the iPhone's (LabReview.swift).
 */
object LabReviewText {
    /** "Reviewed by Codex: all answered". The login ("Codex (codex-1)") is left off. */
    fun heading(r: PhoneLabReview): String {
        val name = r.reviewer.split(" (").first().ifEmpty { r.reviewer }
        val who = if (r.independent) "Reviewed by $name" else "Reviewed by a fresh $name session"
        val rounds = if (r.rounds > 1) ", ${r.rounds} rounds" else ""
        val open = r.findings.count { it.outcome == null || it.outcome == "left" }
        val result = when {
            r.unstructured == true -> "see its reply"
            r.unchecked == true -> "last fixes not re-reviewed"
            r.passed -> if (r.findings.isEmpty()) "nothing found" else "passed"
            open > 0 -> "$open open"
            else -> "all answered"
        }
        return "$who$rounds: $result"
    }

    enum class Outcome(val words: String) { FIXED("Fixed"), DISPUTED("Disputed"), LEFT("Left for you"), NONE("No answer") }

    fun outcome(f: PhoneReviewFinding): Outcome = when (f.outcome) {
        "fixed" -> Outcome.FIXED
        "disputed" -> Outcome.DISPUTED
        "left" -> Outcome.LEFT
        else -> Outcome.NONE
    }

    /** The line under a finding: what was done, the agent's note, how serious, and where. */
    fun detail(f: PhoneReviewFinding): String {
        var line = outcome(f).words
        if (!f.note.isNullOrEmpty()) line += ": ${f.note}"
        if (f.severity == "high") line += " · serious"
        if (!f.where.isNullOrEmpty()) line += " · ${f.where}"
        return line
    }

    /**
     * The seq of the reply the review goes over: the last assistant message
     * of the turn the row says it's from. Null when that reply isn't
     * loaded, or an older runner's row names no turn: not shown, rather
     * than on the wrong reply.
     */
    fun replySeq(messages: List<PhoneMessage>, cardTurn: String?): Int? {
        if (cardTurn == null) return null
        return messages.lastOrNull { it.role == Role.ASSISTANT && !it.plan && it.turn == cardTurn }?.seq
    }
}
