package com.mikerosoft.threadbear.android

import android.content.Context
import com.mikerosoft.threadbear.kit.BackendApi
import com.mikerosoft.threadbear.kit.CommandKey
import com.mikerosoft.threadbear.kit.CommandStatus
import com.mikerosoft.threadbear.kit.PendingCommand
import com.mikerosoft.threadbear.kit.PendingCommands
import com.mikerosoft.threadbear.kit.InboxCleared
import com.mikerosoft.threadbear.kit.InboxSections
import com.mikerosoft.threadbear.kit.NotifyMode
import com.mikerosoft.threadbear.kit.PhoneBackend
import com.mikerosoft.threadbear.kit.PhoneRunner
import com.mikerosoft.threadbear.kit.PhoneThread
import com.mikerosoft.threadbear.kit.PocketCard
import com.mikerosoft.threadbear.kit.PocketDeck
import com.mikerosoft.threadbear.kit.PocketStore
import com.mikerosoft.threadbear.kit.RunnerOrder
import com.mikerosoft.threadbear.kit.ScheduleWake
import com.mikerosoft.threadbear.kit.StartingThread
import com.mikerosoft.threadbear.kit.ThreadChange
import com.mikerosoft.threadbear.kit.ThreadsView
import com.mikerosoft.threadbear.kit.TransportError
import com.mikerosoft.threadbear.kit.Tucks
import java.io.File
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.retryWhen
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The inbox's and the app shell's own state, beside AppModel (the iPhone's
 * AppModel keeps these in one class; here they're apart so the screens other
 * work adds to AppModel merge cleanly): archives and hibernates that show at
 * once, the Pocket, the new threads on their way, the runner order and when
 * this phone is notified.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ShellModel(private val app: AppModel, context: Context, private val scope: CoroutineScope) {
    private val prefs = context.getSharedPreferences("shell", Context.MODE_PRIVATE)

    // Archive and hibernate, at once

    /**
     * Hibernated from this phone, kept out of the lists and on the heading's
     * count until Convex catches up. The command itself is in app.commands;
     * this is the heading's count, which the lists catch up with separately.
     */
    val tucks = MutableStateFlow(Tucks())
    /** He's just taken the last row away, for the empty inbox to greet it. */
    private val inboxCleared = InboxCleared()
    private var lastInbox: List<PhoneThread> = emptyList()
    private var lastHibernatingCount: Int? = null

    /**
     * The inbox's sections less what's on its way out from here (an archive
     * that holdsChange, which waits for the Mac if it's asleep), and with the
     * changes tapped here shown (AppModel.shown). [pending] is app.commands'
     * entries as the screen collected them.
     */
    fun sections(list: List<PhoneThread>, now: Instant, wakes: Map<String, ScheduleWake>, pending: Map<CommandKey, PendingCommands.Entry> = app.commands.entries.value): InboxSections {
        val gone = tucks.value.hidden
        val archiving = pending.filter { (key, entry) -> key is CommandKey.Archive && entry.state.holdsChange }.keys.map { (it as CommandKey.Archive).threadId }.toSet()
        return InboxSections.build(list.filter { it.threadId !in gone && it.threadId !in archiving }.map { app.shown(it, pending) }, now, wakes)
    }

    /** A new inbox list: what it no longer has, or has asleep, is done. */
    fun inboxArrived(list: List<PhoneThread>) {
        lastInbox = list
        // Gone from the list once done: let go, so a later unarchive shows.
        val ids = list.map { it.threadId }.toSet()
        app.commands.forgetWhere { key, state -> key is CommandKey.Archive && key.threadId !in ids && state is PendingCommand.Done }
        tucks.update { it.inboxArrived(list, Instant.now()) }
    }

    /** phone:counts moved: what it's gained is no longer ours to add. */
    fun countsArrived(hibernating: Int?) {
        tucks.update { it.countsArrived(lastHibernatingCount, hibernating) }
        lastHibernatingCount = hibernating
    }

    /** Whether to celebrate, once: the empty inbox asks as it appears. */
    fun takeInboxCleared(): Boolean = inboxCleared.take(Instant.now())

    /** A row he's taken away, which may be the last: only this counts as clearing the inbox. */
    private fun takeOffInbox(change: () -> Unit) {
        val wakes = InboxSections.wakes(app.wakes.value)
        val now = Instant.now()
        val before = sections(lastInbox, now, wakes)
        change()
        inboxCleared.note(before, sections(lastInbox, now, wakes), now)
    }

    /** Whether an archive from here is keeping the row out of the inbox (the swipe stays gone). */
    fun archiving(threadId: String) = app.commands[CommandKey.Archive(threadId)].holdsChange

    /**
     * Archives a thread, gone from the inbox at once and kept gone until the
     * list drops it (half a minute after it's done at most), back with why
     * if the runner refuses it.
     */
    fun archive(threadId: String, change: ThreadChange = ThreadChange.Archive) {
        val b = app.backend.value ?: return
        val key = CommandKey.Archive(threadId)
        if (app.commands[key].locked) return
        val start = {
            app.commands.start(key, settleMs = 30_000, send = { b.update(threadId, change) }) { state ->
                app.said(state, "The runner couldn't archive that thread.")
                // Done with the inbox already without it: nothing left to hide.
                if (state is PendingCommand.Done && lastInbox.none { it.threadId == threadId }) app.commands.forget(key)
            }
        }
        if (lastInbox.any { it.threadId == threadId }) takeOffInbox { start() } else start()
    }

    /**
     * Hibernates a thread, as `archive` archives one. A starred thread stays
     * under Starred with a moon, and one only waiting on a schedule is under
     * Hibernating already, so neither has anywhere to go.
     */
    fun hibernate(threadId: String, change: ThreadChange) {
        val b = app.backend.value ?: return
        val key = CommandKey.Hibernate(threadId)
        if (archiving(threadId) || threadId in tucks.value.hidden || app.commands[key].locked) return
        val s = sections(lastInbox, Instant.now(), InboxSections.wakes(app.wakes.value))
        if ((s.inbox + s.running).any { it.threadId == threadId }) takeOffInbox { tucks.update { it.tuck(threadId) } }
        app.commands.start(key, send = { b.update(threadId, change) }) { state ->
            if (!state.holdsChange) tucks.update { it.undo(threadId) }
            app.said(state, "The runner couldn't hibernate that thread.")
        }
    }

    /**
     * Woken or unarchived from a put-away list, hidden there until the runner
     * has done it (AppModel.bringingBack): a swipe that only snapped back
     * looked as if it hadn't taken.
     */
    fun bringBack(threadId: String, change: ThreadChange) = app.change(threadId, change)

    // Search

    /**
     * Archived threads past the den's newest 100 with these words in (API
     * 16). Empty from an older backend, or when the call fails: the search
     * still shows what the phone has, so a failure isn't worth a note.
     */
    suspend fun searchOlderArchived(text: String): List<PhoneThread> {
        val b = app.backend.value ?: return emptyList()
        if (app.apiVersion < BackendApi.SEARCH) return emptyList()
        return try { b.search(text) } catch (e: CancellationException) { throw e } catch (_: Exception) { emptyList() }
    }

    /** The put-away lists a search looks through too, only while one's on. */
    private fun putAwayForSearch(view: ThreadsView): StateFlow<List<PhoneThread>> = app.backend.flatMapLatest { b ->
        b?.threads(view)?.retryWhen { _, _ -> delay(2000); true }?.catch { } ?: flowOf(emptyList())
    }.stateIn(scope, SharingStarted.WhileSubscribed(5000), emptyList())

    val searchHibernating = putAwayForSearch(ThreadsView.HIBERNATING)
    val searchArchived = putAwayForSearch(ThreadsView.DEN)

    // The Pocket

    private val pocketStore = PocketStore(File(context.noBackupFilesDir, "pocket.json"))
    /** Swiped away here, hidden until the backend's list agrees (or back if it refused). */
    private val removing = MutableStateFlow<Set<String>>(emptySet())

    /**
     * The Pocket's cards: from the file until the backend answers, so they
     * show with no signal, and saved each time they change.
     */
    private val pocketCards: StateFlow<List<PocketCard>> = app.identity.flatMapLatest { me ->
        val b = app.backend.value
        when {
            // Unpaired: nothing of the last server's stays on show.
            b == null -> flowOf(emptyList<PocketCard>())
            // Not known yet (offline at launch), or an older backend: the cards from the file.
            me == null || (me.apiVersion ?: 0) < BackendApi.POCKET -> emptyFlow<List<PocketCard>>()
            else -> b.pocket().retryWhen { cause, _ -> if (cause is TransportError.Unauthorized) false else { delay(2000); true } }.catch { }
        }
    }.onEach { cards ->
        pocketStore.save(cards)
        val ids = cards.map { it.id }.toSet()
        removing.update { it intersect ids }
    }.stateIn(scope, SharingStarted.WhileSubscribed(5000), pocketStore.load())

    val pocket: StateFlow<List<PocketCard>> = combine(pocketCards, removing) { cards, gone -> cards.filter { it.id !in gone } }
        .stateIn(scope, SharingStarted.WhileSubscribed(5000), pocketStore.load())

    /**
     * The newest card's time when the Pocket was last open, for the badge on
     * its button. Kept on this phone only: it's about what this phone has shown.
     */
    val pocketSeenUpTo = MutableStateFlow(prefs.getString("pocketSeenUpTo", null))

    fun pocketHasNew(cards: List<PocketCard>, seen: String?) = PocketDeck.hasNew(cards, seen)

    fun markPocketSeen(cards: List<PocketCard>) {
        val seen = PocketDeck.seenUpTo(cards, pocketSeenUpTo.value)
        if (seen == pocketSeenUpTo.value) return
        pocketSeenUpTo.value = seen
        prefs.edit().putString("pocketSeenUpTo", seen).apply()
    }

    /** Gone at once, and back if the backend wouldn't have it. */
    fun removePocketCard(card: PocketCard) {
        val b = app.backend.value ?: return
        removing.update { it + card.id }
        scope.launch {
            try {
                b.removePocketCard(card.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                removing.update { it - card.id }
                app.report(e)
            }
        }
    }

    // New threads on their way

    /**
     * New threads asked for from this phone that their runner hasn't made
     * yet, newest first, shown at the top of the inbox (StartingThread says why).
     */
    val starting = MutableStateFlow<List<StartingThread>>(emptyList())
    private val startingJobs = HashMap<String, Job>()
    /** Only the newest start opens by itself: an earlier one landing while you wait on the next mustn't take its place. */
    private var latestStart: String? = null
    /** A thread that started soon after it was asked for, for the inbox to open. */
    val justStarted = MutableStateFlow<String?>(null)
    /** A failed start, for New thread to open again as it was: words, photos, runner, model and effort. */
    val retryDraft = MutableStateFlow<NewThreadDraft?>(null)
    /** Each start's screen as it was, by its command id, for trying again. */
    private val drafts = HashMap<String, NewThreadDraft>()
    /**
     * Words for New thread to open with, as the iPhone's model.composeText:
     * the Pocket's "Add to my pocket: ". New thread reads it and sets it back to null.
     */
    val composeText = MutableStateFlow<String?>(null)

    /** Call once phone:create has answered with its command id; New thread can close then. */
    fun started(commandId: String, message: String, runnerId: String? = null, photos: Int = 0, draft: NewThreadDraft? = null) {
        draft?.let { drafts[commandId] = it }
        starting.update { listOf(StartingThread(commandId, message, runnerId, photos, Instant.now())) + it }
        latestStart = commandId
        watchStarting(commandId)
    }

    /** Gone from the list: a failed one dismissed, or tapped to try again. */
    fun dropStarting(id: String) {
        startingJobs.remove(id)?.cancel()
        drafts.remove(id)
        starting.update { list -> list.filter { it.id != id } }
    }

    /** A failed one back in New thread as it was. */
    fun retryStarting(row: StartingThread) {
        val draft = drafts[row.id] ?: NewThreadDraft(row.message, emptyList(), row.runnerId)
        dropStarting(row.id)
        retryDraft.value = draft
    }

    private fun watchStarting(id: String) {
        startingJobs[id]?.cancel()
        startingJobs[id] = scope.launch {
            while (true) {
                val b = app.backend.value ?: return@launch
                try {
                    b.command(id).collect { status -> if (startingChanged(id, status)) throw Done() }
                    // The subscription ended: the command's gone.
                    startingChanged(id, null)
                    return@launch
                } catch (_: Done) {
                    return@launch
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    delay(2000)
                }
            }
        }
    }

    private class Done : Exception()

    /** True once there's nothing left to watch. */
    private fun startingChanged(id: String, status: CommandStatus?): Boolean {
        val row = starting.value.firstOrNull { it.id == id } ?: return true
        return when (val o = StartingThread.outcome(status)) {
            is StartingThread.Outcome.Started -> {
                starting.update { list -> list.filter { it.id != id } }
                startingJobs.remove(id)
                drafts.remove(id)
                if (id == latestStart && Instant.now() < row.startedAt.plus(StartingThread.OPENS_WITHIN)) justStarted.value = o.threadId
                true
            }
            is StartingThread.Outcome.Failed -> {
                starting.update { list -> list.map { if (it.id == id) it.copy(failed = o.note) else it } }
                startingJobs.remove(id)
                // The backend deleted its copies with the failed command: a retry uploads them again.
                drafts[id]?.photos?.forEach { it.attach(null) }
                true
            }
            StartingThread.Outcome.Gone -> {
                starting.update { list -> list.filter { it.id != id } }
                startingJobs.remove(id)
                drafts.remove(id)
                true
            }
            StartingThread.Outcome.Waiting -> false
        }
    }

    // Runners

    /**
     * The order last dragged to, until the backend's list comes back in it:
     * a heartbeat's update in between would otherwise snap the list back,
     * and the next drag would move the wrong row.
     */
    private val pendingRunnerOrder = MutableStateFlow<List<String>?>(null)

    val runners: StateFlow<List<PhoneRunner>> = combine(app.runners, pendingRunnerOrder) { list, pending ->
        val got = RunnerOrder.receive(list, pending)
        if (pending != null && got.caughtUp && list.isNotEmpty()) pendingRunnerOrder.compareAndSet(pending, null)
        got.runners
    }.stateIn(scope, SharingStarted.WhileSubscribed(5000), emptyList())

    /** Whether there's a runner to choose (backend API 56, which lists them in Mike's order). */
    fun canChooseRunner(runners: List<PhoneRunner>) = runners.size > 1 && app.apiVersion >= BackendApi.RUNNER_ORDER

    /** Puts the runners in this order, here at once and then on the backend. */
    fun setRunnerOrder(order: List<PhoneRunner>) {
        val ids = order.map { it.runnerId }
        pendingRunnerOrder.value = ids
        val b = app.backend.value ?: return
        scope.launch {
            try {
                b.setRunnerOrder(ids)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                pendingRunnerOrder.compareAndSet(ids, null)
                app.note("Couldn't save the runner order: ${e.message}")
            }
        }
    }

    // Notifications

    /** When this phone is notified, kept on the phone and sent with each change (API 3). */
    val notifyMode = MutableStateFlow(NotifyMode.of(prefs.getString("notifyMode", null)))
    /**
     * This phone's push token once it has one. Push is its own work: whatever
     * registers the phone sets this, and sends `notifyMode` with it.
     */
    val pushToken = MutableStateFlow<String?>(null)

    /** The setting shows once the backend takes it and notifications are on. */
    fun canChooseNotifications(token: String?) = token != null && app.apiVersion >= BackendApi.NOTIFICATION_SETTING

    fun setNotifyMode(mode: NotifyMode) {
        notifyMode.value = mode
        prefs.edit().putString("notifyMode", mode.wire).apply()
        val b = app.backend.value ?: return
        val token = pushToken.value ?: return
        scope.launch {
            try {
                b.setNotifications(token, mode)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.note("Couldn't change notifications: ${e.message}")
            }
        }
    }

    /** Unpaired: nothing of the last server's is kept. */
    fun clear() {
        pocketStore.clear()
        prefs.edit().remove("pocketSeenUpTo").apply()
        pocketSeenUpTo.value = null
        removing.value = emptySet()
        startingJobs.values.forEach { it.cancel() }
        startingJobs.clear()
        starting.value = emptyList()
        drafts.clear()
        retryDraft.value = null
        tucks.value = Tucks()
        pendingRunnerOrder.value = null
        lastInbox = emptyList()
        lastHibernatingCount = null
    }
}
