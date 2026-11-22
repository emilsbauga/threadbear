package com.mikerosoft.threadbear.kit

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Every command this phone has on its way, by what it's about ([CommandKey]),
 * and the one watcher that moves each through [PendingCommand]
 * (PendingCommands.swift on the iPhone): it sends, follows the command's row
 * through [rows] (the app's follows whichever backend is current), times it
 * out, and lets go a moment after it's done. A control reads its state here
 * and shows it: spinning while locked, its change kept while holdsChange, the
 * failure where it is. Cancelling [scope] (or [forget], [clear]) stops a
 * watch, and that cancellation is never taken for a failure.
 *
 * Not thread-safe: use it from one thread (the app's main scope, a test's).
 */
class PendingCommands<K : Any>(
    private val scope: CoroutineScope,
    private val rows: (commandId: String) -> Flow<CommandStatus?>,
    private val now: () -> Long = System::currentTimeMillis,
    /** How long until nothing heard is timed out; short in tests. */
    val deadlineMs: Long = PendingCommand.DEADLINE_MS,
    /** How long a subscription that failed waits to try again. */
    private val retryMs: Long = 2_000,
) {
    data class Entry(val state: PendingCommand, val value: String? = null)

    private val _entries = MutableStateFlow<Map<K, Entry>>(emptyMap())
    /** Every command on its way, for a screen to collect and redraw from. */
    val entries: StateFlow<Map<K, Entry>> = _entries

    operator fun get(key: K): PendingCommand = _entries.value[key]?.state ?: PendingCommand.Idle

    /** What was asked for, for the control to show at once (a new title, "on" for a star, the button tapped). */
    fun value(key: K): String? = _entries.value[key]?.value

    /** Each command's own work: the send, the row's subscription, the clock. */
    private class Run(val settleMs: Long?, val then: (PendingCommand) -> Unit) {
        var send: Job? = null
        var watch: Job? = null
        var clock: Job? = null
        var settle: Job? = null
        fun cancel() {
            send?.cancel(); watch?.cancel(); clock?.cancel(); settle?.cancel()
        }
    }

    private val runs = HashMap<K, Run>()

    /**
     * Sends a command, unless one about the same thing is still locked. [then]
     * hears it end: done, failed, or timed out (which can still end in done or
     * failed later). Done lets go after [settleMs], or with null only at [forget].
     */
    fun start(
        key: K,
        value: String? = null,
        settleMs: Long? = 3_000,
        send: suspend () -> String,
        then: (PendingCommand) -> Unit = {},
    ): Boolean {
        if (get(key).locked) return false
        runs.remove(key)?.cancel()
        val run = Run(settleMs, then)
        runs[key] = run
        _entries.update { it + (key to Entry(PendingCommand.Idle, value)) }
        apply(key, run, PendingCommand.Event.Tap(now()))
        run.send = scope.launch {
            val id = try {
                send()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                apply(key, run, PendingCommand.Event.SendFailed(e.message ?: "Something went wrong"))
                return@launch
            }
            apply(key, run, PendingCommand.Event.Sent(id, now()))
            if (runs[key] === run && get(key) is PendingCommand.Queued) watch(key, run, id)
        }
        return true
    }

    /** The connection dropped and came back: every clock starts again, and every row is followed afresh. */
    fun reconnected() {
        for ((key, run) in runs.toMap()) {
            apply(key, run, PendingCommand.Event.Reconnected(now()))
            val state = get(key)
            val id = state.id
            if (state.waiting && id != null) watch(key, run, id)
        }
    }

    /** The backend took it back. */
    fun cancelled(key: K) {
        val run = runs[key] ?: return
        apply(key, run, PendingCommand.Event.Cancelled)
    }

    /** Lets go of one, whatever it's doing: the row it was about has caught up. */
    fun forget(key: K) {
        runs.remove(key)?.cancel()
        _entries.update { it - key }
    }

    /** Lets go of every one matching, as [forget]. */
    fun forgetWhere(match: (K, PendingCommand) -> Boolean) {
        for ((key, entry) in _entries.value) if (match(key, entry.state)) forget(key)
    }

    /** Unpaired: nothing of the old pairing's stays. */
    fun clear() {
        runs.values.forEach { it.cancel() }
        runs.clear()
        _entries.value = emptyMap()
    }

    private fun apply(key: K, run: Run, event: PendingCommand.Event) {
        if (runs[key] !== run) return
        val entry = _entries.value[key] ?: return
        val before = entry.state
        val after = before.step(event, deadlineMs)
        if (after == before) return
        if (after == PendingCommand.Idle) {
            runs.remove(key)?.cancel()
            _entries.update { it - key }
            return
        }
        _entries.update { it + (key to entry.copy(state = after)) }
        arm(key, run)
        when (after) {
            is PendingCommand.Done -> {
                run.watch?.cancel()
                run.then(after)
                run.settleMs?.let { ms ->
                    run.settle = scope.launch {
                        delay(ms)
                        apply(key, run, PendingCommand.Event.Settle)
                    }
                }
            }
            is PendingCommand.Failed -> {
                run.watch?.cancel()
                run.then(after)
            }
            is PendingCommand.TimedOut -> run.then(after)
            PendingCommand.Idle, is PendingCommand.Sending, is PendingCommand.Queued, is PendingCommand.Taken -> {}
        }
    }

    /** The clock, set for the state's deadline, if it has one. */
    private fun arm(key: K, run: Run) {
        run.clock?.cancel()
        val at = get(key).deadlineAt(deadlineMs) ?: return
        run.clock = scope.launch {
            delay((at - now()).coerceAtLeast(0))
            apply(key, run, PendingCommand.Event.Deadline(maxOf(now(), at)))
        }
    }

    /** The command's row until it's done or failed; a subscription that fails or ends is tried again. */
    private fun watch(key: K, run: Run, id: String) {
        run.watch?.cancel()
        run.watch = scope.launch {
            while (runs[key] === run && !get(key).finished) {
                try {
                    rows(id).first { row ->
                        apply(key, run, PendingCommand.Event.Row(row, now()))
                        runs[key] !== run || get(key).finished
                    }
                    return@launch
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    delay(retryMs)
                }
            }
        }
    }
}
