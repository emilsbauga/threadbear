// The scheduler wants the whole schedules table, now and whenever it changes.
// Reading it whole on every change cost about 170 KB a run on each of three
// runners, and every run of a schedule writes it. So: read it once, then only
// the rows written since (sync:schedulesSince, API 48), as the inbox does. A
// row written can commit a moment after one stamped later, so each ask starts a
// little before the newest row heard, which only re-reads a row or two.
export const SCHEDULE_MARGIN_MS = 5000;

export type ScheduleAnswer<R> = { rows: (R & { updatedMs?: number })[]; gone: string[]; at: number; more?: boolean };
type Subscribe = (fn: string, args: Record<string, unknown>, onUpdate: (v: unknown) => void, onError: (e: Error) => void) => () => void;

function defaultWait(run: () => void, ms: number): () => void {
  const t = setTimeout(run, ms);
  t.unref?.();
  return () => clearTimeout(t);
}

export function followSchedules<R extends { id: string }>(subscribe: Subscribe, key: unknown, onRows: (rows: R[]) => void, onError: (e: Error) => void, wait: (run: () => void, ms: number) => () => void = defaultWait): () => void {
  const held = new Map<string, R>();
  let since: number | undefined;
  let asked = 0;
  let unsub: (() => void) | undefined;
  let stopped = false;
  // When an answer last said to read it all again, by the backend's clock.
  let overAt = -Infinity;
  let cancelWait: (() => void) | undefined;

  const ask = () => {
    unsub?.();
    unsub = undefined;
    if (stopped) return;
    const mine = ++asked;
    const from = since;
    const stop = subscribe(
      'sync:schedulesSince',
      from === undefined ? { key, fresh: Date.now() } : { key, since: from },
      (v) => {
        // An answer to an ask that's been replaced says nothing about now.
        if (mine === asked && !stopped) answer(v as ScheduleAnswer<R>, from);
      },
      onError,
    );
    if (mine === asked && !stopped) unsub = stop;
    else stop();
  };

  const answer = (a: ScheduleAnswer<R>, from: number | undefined) => {
    // Away too long, or too much changed: read it all again.
    if (a.more) {
      since = undefined;
      // A burst bigger than one answer, still inside the margin, says this again
      // straight after a whole read. Only wait it out: asking from past the read
      // instead would miss a row stamped before it that commits after it.
      const again = a.at - overAt < 2 * SCHEDULE_MARGIN_MS;
      overAt = a.at;
      if (again) {
        unsub?.();
        unsub = undefined;
        asked++;
        cancelWait = wait(() => {
          cancelWait = undefined;
          ask();
        }, SCHEDULE_MARGIN_MS);
      } else ask();
      return;
    }
    let changed = from === undefined;
    if (from === undefined) held.clear();
    let next = from !== undefined ? from : a.at - SCHEDULE_MARGIN_MS;
    for (const { updatedMs, ...row } of a.rows) {
      const r = row as unknown as R;
      if (JSON.stringify(held.get(r.id)) !== JSON.stringify(r)) changed = true;
      held.set(r.id, r);
      if (updatedMs !== undefined) next = Math.max(next, updatedMs - SCHEDULE_MARGIN_MS);
    }
    for (const id of a.gone) if (held.delete(id)) changed = true;
    if (changed) onRows([...held.values()]);
    // The same place until something newer has been heard, so a re-run with
    // nothing new doesn't start another subscription.
    if (next !== since) {
      since = next;
      ask();
    }
  };

  ask();
  return () => {
    stopped = true;
    cancelWait?.();
    unsub?.();
    unsub = undefined;
  };
}
