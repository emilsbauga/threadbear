package com.mikerosoft.threadbear.kit

/**
 * What a thread is waiting on, worked out by the runner and sent on each row
 * as `waitState` (docs/protocol/needs-you.md, "Wait state"; the reference is
 * runner/src/wait-state.ts). The app draws it instead of working it out, so
 * the phone, the Mac and the website put a thread under the same heading and
 * count it the same way. Rows from a runner before 23 Nov 2026 have none, and
 * get the app's own rule (InboxSections' legacy functions).
 */
enum class WaitState(val wire: String, val section: PhoneSection) {
    WORKING("working", PhoneSection.RUNNING),
    JOB("job", PhoneSection.RUNNING),
    ON_THREADS("onThreads", PhoneSection.RUNNING),
    LANDING("landing", PhoneSection.RUNNING),
    APP_RESTART("appRestart", PhoneSection.RUNNING),
    /** Only an app's own guess while a message is on its way; the runner never sends it. */
    SENDING("sending", PhoneSection.RUNNING),
    CARD("card", PhoneSection.INBOX),
    REVIEW("review", PhoneSection.INBOX),
    NEEDS_YOU("needsYou", PhoneSection.INBOX),
    LIMIT("limit", PhoneSection.INBOX),
    DONE("done", PhoneSection.INBOX),
    SCHEDULED("scheduled", PhoneSection.HIBERNATING),
    HIBERNATING("hibernating", PhoneSection.HIBERNATING),
    ARCHIVED("archived", PhoneSection.ARCHIVED),
    ;

    /** The heading it goes under: Starred instead for a starred thread that isn't archived. */
    fun section(starred: Boolean): PhoneSection =
        if (this != ARCHIVED && starred) PhoneSection.STARRED else section

    /**
     * How much it wants Mike, lowest first, for the Inbox's Needs you order:
     * 0 stuck on him, 1 asking after a failed or stopped turn, 2 asking him
     * (read or not) or out of usage, 3 done after a failed or stopped turn,
     * 4 done or not in the Inbox.
     */
    fun urgency(status: ThreadStatus): Int {
        val broken = status == ThreadStatus.ERROR || status == ThreadStatus.STOPPED
        return when (this) {
            CARD, REVIEW -> 0
            NEEDS_YOU -> if (broken) 1 else 2
            LIMIT -> 2
            DONE -> if (broken) 3 else 4
            else -> 4
        }
    }

    /** In the badge and the Needs you filter. */
    fun counts(status: ThreadStatus) = InboxUrgency.counts(urgency(status))

    companion object {
        /** Null when the row has none (an older runner); a value this build doesn't know is drawn as done. */
        fun of(wire: String?): WaitState? = wire?.let { w -> entries.firstOrNull { it.wire == w } ?: DONE }
    }
}

/**
 * This app's own guesses at the state while a change tapped here is on its
 * way (AppModel.shown), until the runner's next row says. A row without a
 * state is left alone: the old rule reads the changed fields.
 */
object WaitGuess {
    private val PUT_AWAY = setOf(WaitState.HIBERNATING, WaitState.ON_THREADS, WaitState.LANDING, WaitState.APP_RESTART)

    /** Read: no longer wanting him, unless the last turn asked him for something still open. */
    fun seen(t: PhoneThread): PhoneThread {
        val read = t.copy(unread = false, needsYou = false)
        return if (read.waitState == WaitState.NEEDS_YOU && !read.waitingOnMike) read.copy(waitState = WaitState.DONE) else read
    }

    /**
     * Woken off a snooze, or unarchived: the state is dropped, so the old rule
     * draws the row from its fields until the runner says (as the iPhone does).
     * A guess here can't tell a running turn or an open card from a finished
     * one (Codex's review, 23 Nov).
     */
    fun woken(t: PhoneThread): PhoneThread = backFrom(t, PUT_AWAY)

    /** Unarchived, the same. */
    fun unarchived(t: PhoneThread): PhoneThread = backFrom(t, setOf(WaitState.ARCHIVED))

    private fun backFrom(t: PhoneThread, from: Set<WaitState>): PhoneThread =
        if (t.waitState in from) t.copy(waitState = null) else t
}
