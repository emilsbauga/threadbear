package com.mikerosoft.threadbear.kit

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/** The inbox's headings, top to bottom, as on the Mac sidebar. */
enum class PhoneSection(val title: String, val view: ThreadsView?) {
    STARRED("Starred", null),
    INBOX("Inbox", null),
    RUNNING("Running", null),
    HIBERNATING("Hibernating", ThreadsView.HIBERNATING),
    ARCHIVED("Archived", ThreadsView.DEN),
}

/** Which headings are folded. Everything but Starred and Inbox starts folded. */
data class SectionFolds(private val foldedSet: Set<PhoneSection> = INITIAL) {
    val folded: Set<PhoneSection> = foldedSet - PhoneSection.INBOX

    fun isFolded(section: PhoneSection) = section != PhoneSection.INBOX && section in folded

    fun toggle(section: PhoneSection): SectionFolds {
        if (section == PhoneSection.INBOX) return this
        return SectionFolds(if (section in folded) folded - section else folded + section)
    }

    /** The backend lists to keep a subscription to. */
    fun views(): Set<ThreadsView> =
        setOf(ThreadsView.INBOX) + PhoneSection.entries.filter { !isFolded(it) }.mapNotNull { it.view }

    val saved: List<String> get() = folded.map { it.name.lowercase() }.sorted()

    companion object {
        val INITIAL = setOf(PhoneSection.RUNNING, PhoneSection.HIBERNATING, PhoneSection.ARCHIVED)

        fun fromSaved(saved: List<String>?): SectionFolds =
            SectionFolds(saved?.mapNotNull { s -> PhoneSection.entries.firstOrNull { it.name.lowercase() == s } }?.toSet() ?: INITIAL)
    }
}

/** How much an inbox thread wants Mike, lowest first (InboxUrgency.swift). */
object InboxUrgency {
    fun of(answerWaiting: Boolean, needsYou: Boolean, broken: Boolean): Int = when {
        answerWaiting -> 0
        needsYou -> if (broken) 1 else 2
        else -> if (broken) 3 else 4
    }

    fun counts(urgency: Int) = urgency <= 2
}

/** The inbox's sections, the same rules as the Mac's ThreadSections.build. */
data class InboxSections(
    val starred: List<PhoneThread> = emptyList(),
    val inbox: List<PhoneThread> = emptyList(),
    val running: List<PhoneThread> = emptyList(),
    val scheduled: List<PhoneThread> = emptyList(),
) {
    /**
     * The badge: threads waiting on an answer or wanting him. A starred one
     * put away doesn't count: with a wait state its urgency says so, before
     * that its snooze.
     */
    val needsYouCount: Int
        get() {
            val awake = starred.filter { it.waitState != null || (it.snoozedUntil == null && it.snoozedUntilRestart != true) }
            return (awake + inbox).count { InboxUrgency.counts(urgency(it)) }
        }

    val isEmpty get() = starred.isEmpty() && inbox.isEmpty() && running.isEmpty() && scheduled.isEmpty()

    companion object {
        fun build(threads: Iterable<PhoneThread>, now: Instant, wakes: Map<String, ScheduleWake> = emptyMap()): InboxSections {
            val starred = mutableListOf<PhoneThread>()
            val inbox = mutableListOf<PhoneThread>()
            val running = mutableListOf<PhoneThread>()
            val scheduled = mutableListOf<PhoneThread>()
            for (t in threads) {
                when (placement(t, now, wakes)) {
                    PhoneSection.STARRED -> starred += t
                    PhoneSection.INBOX -> inbox += t
                    PhoneSection.RUNNING -> running += t
                    PhoneSection.HIBERNATING -> scheduled += t
                    PhoneSection.ARCHIVED, null -> {}
                }
            }
            starred.sortWith(compareBy<PhoneThread> { it.starredAt ?: Instant.MAX }.thenBy { it.threadId })
            inbox.sortWith(compareBy<PhoneThread> { urgency(it) }.then(NEWEST_FIRST))
            running.sortWith(NEWEST_FIRST)
            scheduled.sortWith(compareBy<PhoneThread> { wakes[it.threadId]?.nextRunAt ?: Instant.MAX }.then(NEWEST_FIRST))
            return InboxSections(starred, inbox, running, scheduled)
        }

        /** The Hibernating heading: scheduled and snoozed together, soonest to wake first. */
        fun hibernating(scheduled: List<PhoneThread>, snoozed: List<PhoneThread>, wakes: Map<String, ScheduleWake>): List<PhoneThread> {
            val seen = HashSet<String>()
            val all = (scheduled + snoozed).filter { seen.add(it.threadId) }
            val wakesAt = { t: PhoneThread -> t.snoozedUntil ?: wakes[t.threadId]?.nextRunAt ?: Instant.MAX }
            return all.sortedWith(compareBy(wakesAt).then(NEWEST_FIRST))
        }

        /** For each thread a schedule will message, the one due soonest. */
        fun wakes(schedules: Iterable<ScheduleWake>): Map<String, ScheduleWake> {
            val soonest = HashMap<String, ScheduleWake>()
            for (s in schedules) {
                val id = s.threadId ?: continue
                val next = s.nextRunAt ?: continue
                val current = soonest[id]?.nextRunAt
                if (current != null && current <= next) continue
                soonest[id] = s
            }
            return soonest
        }

        /**
         * The heading a thread from the inbox list goes under in `build`, or
         * null for one drawn from another list (Hibernating's snoozed ones,
         * the archived). Under Hibernating here only waiting on a schedule.
         * From a newer runner a thread its agent put away to wait on its own
         * work (other threads, landing, an app restart) is in this list with
         * a snooze, and goes under Running.
         */
        fun placement(t: PhoneThread, now: Instant, wakes: Map<String, ScheduleWake>): PhoneSection? {
            val state = t.waitState ?: return legacyPlacement(t, now, wakes)
            return when (val section = state.section(t.starredAt != null)) {
                PhoneSection.ARCHIVED -> null
                PhoneSection.HIBERNATING -> section.takeIf { state == WaitState.SCHEDULED }
                else -> section
            }
        }

        /**
         * Only for a row without `waitState`, from a runner before 23 Nov
         * 2026: the app's own copy of the rule the runner now works out. Goes
         * once every runner sends it.
         */
        private fun legacyPlacement(t: PhoneThread, now: Instant, wakes: Map<String, ScheduleWake>): PhoneSection? = when {
            t.archivedAt != null -> null
            t.starredAt != null -> PhoneSection.STARRED
            isSnoozed(t, now) -> null
            t.reviewWaiting || needsAnswer(t) || t.waitingOnMike || (t.needsYou && t.working == null) -> PhoneSection.INBOX
            t.isBusy || t.working != null -> PhoneSection.RUNNING
            t.status == ThreadStatus.IDLE && t.needs != "you" && t.waitingForRoom == null && wakes[t.threadId] != null -> PhoneSection.HIBERNATING
            else -> PhoneSection.INBOX
        }

        fun urgency(t: PhoneThread): Int = t.waitState?.urgency(t.status) ?: legacyUrgency(t)

        /** Only for a row without `waitState` (a runner before 23 Nov 2026); goes once every runner sends it. */
        private fun legacyUrgency(t: PhoneThread): Int = InboxUrgency.of(
            answerWaiting = t.reviewWaiting || needsAnswer(t),
            needsYou = t.needsYou,
            broken = t.status == ThreadStatus.ERROR || t.status == ThreadStatus.STOPPED,
        )

        /** Stuck on a card only Mike can answer: the runner's card state, or before it the card or status. */
        fun needsAnswer(t: PhoneThread) =
            t.waitState?.let { it == WaitState.CARD } ?: (t.pendingApproval != null || t.status == ThreadStatus.WAITING)

        /**
         * Under Starred with a moon: put away by a snooze. With a wait state,
         * only when it's hibernating, not one waiting on its own work.
         */
        fun isAsleep(t: PhoneThread, now: Instant): Boolean =
            t.waitState?.let { it == WaitState.HIBERNATING } ?: isSnoozed(t, now)

        fun isSnoozed(t: PhoneThread, now: Instant): Boolean {
            if (t.snoozedUntilRestart == true) return true
            val until = t.snoozedUntil ?: return false
            return until > now
        }

        /** "Until \"Convex I/O\" finishes" while hibernating on more than a time. */
        fun wakeLine(t: PhoneThread, now: Instant): String? {
            val note = t.wakeNote?.takeIf { it.isNotEmpty() } ?: return null
            return if (isSnoozed(t, now)) "Until $note" else null
        }

        val NEWEST_FIRST: Comparator<PhoneThread> =
            compareByDescending<PhoneThread> { it.lastActivityAt }.thenBy { it.threadId }
    }
}

/** What a row says at its right: the status while it means something, else the time. */
object RowStatus {
    enum class Kind { NEEDS_YOU, WORKING, FAILED, WAITING_FOR_CONNECTION, STOPPED, TIME }

    fun kind(t: PhoneThread): Kind {
        val state = t.waitState
        if (state == null) {
            if (t.reviewWaiting || t.pendingApproval != null || t.status == ThreadStatus.WAITING) return Kind.NEEDS_YOU
        } else {
            if (state == WaitState.CARD || state == WaitState.REVIEW) return Kind.NEEDS_YOU
            if (state == WaitState.SENDING) return Kind.WORKING
        }
        return when (t.status) {
            ThreadStatus.RUNNING, ThreadStatus.STARTING -> Kind.WORKING
            ThreadStatus.ERROR -> if (t.waitingForNetwork != null) Kind.WAITING_FOR_CONNECTION else Kind.FAILED
            ThreadStatus.STOPPED -> Kind.STOPPED
            else -> Kind.TIME
        }
    }

    /**
     * The gutter's dot: it wants Mike. With a wait state, whatever the badge
     * counts (a read thread with open asks too, Mike 23 Nov).
     */
    fun wantsMike(t: PhoneThread): Boolean {
        t.waitState?.let { return it.counts(t.status) }
        val kind = kind(t)
        return kind == Kind.NEEDS_YOU || (t.needsYou && kind != Kind.WORKING)
    }

    /** The row's working line ("1 sub-agent"), while a turn or a job is going and not held up on Mike. */
    fun doing(t: PhoneThread): String? = t.working?.takeIf {
        val state = t.waitState
        if (state == null) t.isBusy || (t.pendingApproval == null && !t.waitingOnMike)
        else t.isBusy || state == WaitState.WORKING || state == WaitState.JOB
    }

    fun text(t: PhoneThread, now: Instant, zone: ZoneId = ZoneId.systemDefault()): String = when (kind(t)) {
        Kind.NEEDS_YOU -> "Needs you"
        Kind.WORKING -> "Working"
        Kind.FAILED -> "Failed"
        Kind.WAITING_FOR_CONNECTION -> "Waiting for connection"
        Kind.STOPPED -> "Stopped"
        Kind.TIME -> if (t.woke != null) "Woke up" else RelativeTime.short(t.lastActivityAt, now, zone)
    }

    /** How long a running turn has been going: "53s", "4m", "1h 2m". */
    fun workingLabel(since: Instant, now: Instant): String {
        val seconds = maxOf(0L, ChronoUnit.SECONDS.between(since, now))
        if (seconds < 60) return "${seconds}s"
        val minutes = seconds / 60
        if (minutes < 60) return "${minutes}m"
        val hours = minutes / 60
        return if (minutes % 60 == 0L) "${hours}h" else "${hours}h ${minutes % 60}m"
    }
}

/** Short relative times, as on the Mac sidebar: "now", "5m", "3h", "Mon", "12 Oct". */
object RelativeTime {
    // Both dates held to FlexibleDate's range first, wherever they came from:
    // past it toEpochMilli() overflows and atZone() throws, in the middle of
    // drawing the inbox (Daybreak, 11 Nov 2026).
    fun short(date: Instant, now: Instant, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.UK): String =
        heldShort(FlexibleDate.held(date), FlexibleDate.held(now), zone, locale)

    private fun heldShort(date: Instant, now: Instant, zone: ZoneId, locale: Locale): String {
        val seconds = (now.toEpochMilli() - date.toEpochMilli()) / 1000.0
        if (seconds < 60) return "now"
        if (seconds < 3600) return "${(seconds / 60).saturatingInt()}m"
        if (seconds < 86_400) return "${(seconds / 3600).saturatingInt()}h"
        val d = date.atZone(zone)
        if (seconds < 6 * 86_400) return DateTimeFormatter.ofPattern("EEE", locale).format(d)
        val sameYear = d.year == now.atZone(zone).year
        return DateTimeFormatter.ofPattern(if (sameYear) "d MMM" else "d MMM yyyy", locale).format(d)
    }

    /** "10:42" today, "Mon 10:42" otherwise. */
    fun clock(date: Instant, now: Instant, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.UK): String {
        val d = FlexibleDate.held(date).atZone(zone)
        val sameDay = d.toLocalDate() == FlexibleDate.held(now).atZone(zone).toLocalDate()
        return DateTimeFormatter.ofPattern(if (sameDay) "HH:mm" else "EEE HH:mm", locale).format(d)
    }
}

/** The preview is the start of markdown; rows show plain words (PreviewText). */
object PreviewText {
    private val link = Regex("""!?\[([^\]]*)(?:\]\([^)]*(\))?)?""")
    private val heading = Regex("""(^|\s)(#{1,6}|>)\s+""")
    private val spaces = Regex("""\s+""")

    fun plain(text: String): String {
        var line = link.replace(text) { m -> if (m.groups[2] == null) m.value else m.groupValues[1] }
        line = heading.replace(line, "$1")
        for (marker in listOf("**", "__", "~~", "`")) line = line.replace(marker, "")
        line = spaces.replace(line, " ")
        return line.trim()
    }
}

/** The Hibernate menu: 1 hour, this evening 6 pm, tomorrow 9 am, next Monday 9 am. */
object Hibernate {
    data class Preset(val id: String, val title: String, val date: Instant)

    fun presets(now: Instant, zone: ZoneId = ZoneId.systemDefault()): List<Preset> {
        val out = mutableListOf(Preset("hour", "1 hour", now.plusSeconds(3600)))
        val today = now.atZone(zone).toLocalDate()
        val evening = today.atTime(18, 0).atZone(zone).toInstant()
        if (evening.epochSecond - now.epochSecond > 3600) out += Preset("evening", "This evening, 6 pm", evening)
        out += Preset("tomorrow", "Tomorrow, 9 am", today.plusDays(1).atTime(9, 0).atZone(zone).toInstant())
        for (offset in 1L..7L) {
            val day = today.plusDays(offset)
            if (day.dayOfWeek == java.time.DayOfWeek.MONDAY) {
                out += Preset("monday", "Next Monday, 9 am", day.atTime(9, 0).atZone(zone).toInstant())
                break
            }
        }
        return out
    }
}
