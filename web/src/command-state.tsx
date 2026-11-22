// The one way the website sends a runner a command and follows it to the
// end: useCommand drives the machine in command.ts (every move is there),
// and CommandNote says where it's got to. A control that sends one passes
// `disabled={cmd.busy}` and shows a spinner while it's on its way, so it
// can't be pressed twice (AGENTS.md, "Assume every action is slow to land").
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { commandNote, errorText, idle, locked, slowAt, step, unqueued, type CommandEvent, type CommandState } from './command';

export type Command<P> = {
  state: CommandState<P>;
  // Stops taking clicks: sending, waiting for the runner, gone slow, or
  // just done (for a moment, while the rows it changed catch up).
  busy: boolean;
  // Still on its way and nothing's wrong yet: show a spinner.
  spinning: boolean;
  // A press. Ignored while one is on its way, so a double click sends once;
  // `again` lets a composer send its next message once the last is queued.
  run: (send: () => Promise<Id<'commands'>>, payload: P, opts?: { again?: boolean }) => Promise<void>;
  dismiss: () => void;
  // An earlier message a composer sent before this one that failed later,
  // and its Dismiss. Its draft has gone to onFailed too.
  late?: string;
  clearLate: () => void;
  // Follows those earlier messages to their end: render it somewhere.
  watch: ReactNode;
};

// After done, how long the control stays locked so the rows the command
// changed (a schedule's paused, a thread's shared) have caught up first.
const SETTLE_MS = 1200;
// A timer can wake a little before Date.now() says it's due: look again.
const RECHECK_MS = 250;

// onQueued: the backend has it (a composer clears its text then, not before).
// onFailed: it didn't happen, whether the backend refused it or the runner
// said so later, with what was sent, to put back; `queued` says whether the
// backend had taken it (and so onQueued ran) first.
// keepDone: stay done rather than settling back to idle (a reply button
// stays Pressed, with its thread to open).
export function useCommand<P = undefined>(token: string, handlers: { onQueued?: (payload: P) => void; onFailed?: (error: string, payload: P, queued: boolean) => void; keepDone?: boolean } = {}): Command<P> {
  // The machine's state for the handlers (a double click lands before React
  // renders again), and the same for rendering.
  const now = useRef(idle<P>());
  const [state, setState] = useState(idle<P>);
  const on = useRef(handlers);
  useEffect(() => {
    on.current = handlers;
  });
  const move = useCallback((e: CommandEvent<P>): CommandState<P> => {
    const before = now.current;
    const next = step(before, e);
    if (next === before) return next;
    now.current = next;
    setState(next);
    if (next.kind === 'failed' && before.kind !== 'failed') on.current.onFailed?.(next.error, next.payload, !unqueued(before));
    if (next.kind === 'waiting' && unqueued(before)) on.current.onQueued?.(next.payload);
    return next;
  }, []);

  // Messages a composer sent before the one it's following now: each is
  // still followed to its end, so a failure still says so and gives its
  // draft back.
  const earlierNow = useRef<{ id: string; payload: P }[]>([]);
  const [earlier, setEarlier] = useState<{ id: string; payload: P }[]>([]);
  const [late, setLate] = useState<string | undefined>(undefined);
  const ended = useCallback((id: string, error?: string) => {
    const gone = earlierNow.current.find((e) => e.id === id);
    if (!gone) return;
    earlierNow.current = earlierNow.current.filter((e) => e !== gone);
    setEarlier(earlierNow.current);
    if (error === undefined) return;
    setLate(error);
    on.current.onFailed?.(error, gone.payload, true);
  }, []);

  const id = state.kind === 'waiting' || state.kind === 'slow' ? state.id : undefined;
  const report = useQuery(api.phone.command, id ? { token, commandId: id as Id<'commands'> } : 'skip');
  useEffect(() => {
    if (id && report) move({ kind: 'report', id, report, at: Date.now() });
  }, [id, report, move]);

  // Goes slow when nothing is heard in time.
  const due = slowAt(state);
  useEffect(() => {
    if (due === undefined) return;
    let t: ReturnType<typeof setTimeout>;
    const look = () => {
      const before = now.current;
      if (move({ kind: 'tick', at: Date.now() }) === before && slowAt(before) === due) t = setTimeout(look, RECHECK_MS);
    };
    t = setTimeout(look, Math.max(0, due - Date.now()));
    return () => clearTimeout(t);
  }, [due, move]);

  // Done settles back to idle a moment later.
  const keepDone = handlers.keepDone === true;
  useEffect(() => {
    if (state.kind !== 'done' || keepDone) return;
    const t = setTimeout(() => move({ kind: 'settle' }), SETTLE_MS);
    return () => clearTimeout(t);
  }, [state, keepDone, move]);

  const run = useCallback(
    async (send: () => Promise<Id<'commands'>>, payload: P, opts?: { again?: boolean }) => {
      const before = now.current;
      const s = move({ kind: 'send', payload, at: Date.now(), ...(opts?.again ? { again: true } : {}) });
      // Refused (one is already on its way): this press does nothing.
      if (s === before || s.kind !== 'sending') return;
      // A composer's next message: the last is still followed, apart.
      if ((before.kind === 'waiting' || before.kind === 'slow') && before.id) {
        earlierNow.current = [...earlierNow.current, { id: before.id, payload: before.payload }];
        setEarlier(earlierNow.current);
      }
      const { attempt } = s;
      try {
        const commandId = await send();
        move({ kind: 'queued', attempt, id: commandId, at: Date.now() });
      } catch (e) {
        move({ kind: 'queueFailed', attempt, error: errorText(e) });
      }
    },
    [move],
  );
  const dismiss = useCallback(() => void move({ kind: 'dismiss' }), [move]);
  const clearLate = useCallback(() => setLate(undefined), []);
  const watch = earlier.map((e) => <Earlier key={e.id} token={token} id={e.id} onEnd={ended} />);
  return { state, busy: locked(state), spinning: state.kind === 'sending' || state.kind === 'waiting', run, dismiss, late, clearLate, watch };
}

// One earlier message, followed until its runner says how it went.
function Earlier({ token, id, onEnd }: { token: string; id: string; onEnd: (id: string, error?: string) => void }) {
  const report = useQuery(api.phone.command, { token, commandId: id as Id<'commands'> });
  useEffect(() => {
    if (report?.state === 'done') onEnd(id);
    else if (report?.state === 'failed') onEnd(id, report.note ?? 'unknown error');
  }, [report, id, onEnd]);
  return null;
}

// Where a command has got to, under or beside its control: waiting for the
// Mac, gone slow, or failed with why, and an earlier message that failed
// later. Nothing while it's idle or done, nor while it's sending unless
// `sending` (a control with a spinner of its own says so already).
export function CommandNote({ command, className = '', sending = false }: { command: Pick<Command<unknown>, 'state' | 'dismiss' | 'late' | 'clearLate'>; className?: string; sending?: boolean }) {
  const note = commandNote(command.state, { sending });
  return (
    <>
      {command.late !== undefined ? (
        <div className={`command failed ${className}`} role="alert">
          <span>An earlier message didn’t send: {command.late}</span>
          <button type="button" className="link" onClick={command.clearLate}>
            Dismiss
          </button>
        </div>
      ) : null}
      {note ? (
        <div className={`command ${note.tone} ${className}`} role={note.tone === 'failed' ? 'alert' : 'status'}>
          {note.text === 'Sending…' ? <span className="spinner" /> : null}
          <span>{note.text}</span>
          {note.dismiss ? (
            <button type="button" className="link" onClick={command.dismiss}>
              {command.state.kind === 'slow' ? 'Stop waiting' : 'Dismiss'}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
