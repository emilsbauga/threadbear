// A thread's worktree slot (src/slot.ts): every record state against every
// event, checked against the hand-written writes it replaced, the fields
// read as a Slot and written back unchanged for every shape they can have
// on disk, thousands of random event sequences, what a folder is from its
// snapshot, and a guard that nothing else writes the fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SLOT_FIELDS, moveSlot, slotFields, slotOf, slotOnDisk, writeSlot, type SlotEvent, type SlotSnapshot } from '../../src/slot.ts';
import type { WorktreeRecord } from '../../src/worktrees.ts';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const PAST = '2026-11-20T00:00:00.000Z';
const W = (): WorktreeRecord => ({ repo: 'proj', mainCheckout: path.join('r', 'proj'), path: path.join('r', 'proj-threads', 'slot-1'), branch: 'thread/abcd1234', base: 'b0', keep: ['app/.build'], patchFile: 'p.ts' });
const FRESH = (): WorktreeRecord => ({ ...W(), path: path.join('r', 'proj-threads', 'slot-2'), branch: 'thread/abcd1234' });

type Raw = Record<string, unknown>;
// The record's worktree as found, one of each shape the runner writes and a
// few it doesn't (kept as found).
const STATES: Record<string, Raw | undefined> = {
  none: undefined,
  held: {},
  heldTorn: { tornDownAt: PAST },
  owed: { cleanupOwed: true },
  owedTorn: { cleanupOwed: true, tornDownAt: PAST },
  removed: { removedAt: PAST },
  removedTorn: { removedAt: PAST, tornDownAt: PAST },
  handedOn: { removedAt: PAST, spare: true },
  removedStillOwed: { removedAt: PAST, cleanupOwed: true }, // settleLostCleanups' found-gone leaves it
  handedOnStillOwed: { removedAt: PAST, spare: true, cleanupOwed: true },
  spareOnly: { spare: true },
  emptyRemoved: { removedAt: '', spare: false, cleanupOwed: false },
  oddTypes: { removedAt: 7, spare: 'yes', cleanupOwed: 1, tornDownAt: 5 },
};
const rec = (name: string): { worktree?: WorktreeRecord } => (STATES[name] === undefined ? {} : { worktree: { ...W(), ...structuredClone(STATES[name]) } as WorktreeRecord });

const EVENTS: Record<string, () => SlotEvent> = {
  made: () => ({ kind: 'made', worktree: FRESH(), owed: false }),
  madeArchived: () => ({ kind: 'made', worktree: FRESH(), owed: true }),
  arrived: () => ({ kind: 'arrived', worktree: { ...FRESH(), movedIn: true } }),
  arrivedRemoved: () => ({ kind: 'arrived', worktree: { ...FRESH(), removedAt: PAST, spare: true } }),
  arrivedNone: () => ({ kind: 'arrived' }),
  archived: () => ({ kind: 'archived' }),
  owe: () => ({ kind: 'owe' }),
  tornDown: () => ({ kind: 'tornDown' }),
  toldTornDown: () => ({ kind: 'toldTornDown' }),
  cleanedStays: () => ({ kind: 'cleaned', removed: false }),
  cleanedRemoved: () => ({ kind: 'cleaned', removed: true }),
  cleanedHandedOn: () => ({ kind: 'cleaned', removed: true, handedOn: true }),
  foundGone: () => ({ kind: 'foundGone', taken: false }),
  foundTaken: () => ({ kind: 'foundGone', taken: true }),
};

// The writes as they were by hand before slot.ts, at each site (runner.ts
// update; runner/worktrees.ts prepareWorktreeNow, tearDownWorktree,
// tellTornDown, leaveRemovedWorktreeNow, settleLostCleanups and
// cleanUpWorktree; moves.ts; box-save.ts), each behind the check its caller
// made first.
function byHand(holder: { worktree?: WorktreeRecord }, e: SlotEvent, iso = ISO): void {
  const w = holder.worktree as Raw | undefined;
  switch (e.kind) {
    case 'made':
      holder.worktree = e.worktree;
      if (e.owed) e.worktree.cleanupOwed = true;
      return;
    case 'arrived':
      if (e.worktree) holder.worktree = e.worktree;
      else delete holder.worktree;
      return;
    case 'archived':
      if (w && !w.removedAt) {
        w.cleanupOwed = true;
        delete w.tornDownAt;
      }
      return;
    case 'owe':
      w!.cleanupOwed = true;
      return;
    case 'tornDown':
      w!.tornDownAt = iso;
      return;
    case 'toldTornDown':
      delete w!.tornDownAt;
      return;
    case 'cleaned':
      delete w!.cleanupOwed;
      if (e.removed) {
        w!.removedAt = iso;
        if (e.handedOn) w!.spare = true;
      }
      return;
    case 'foundGone':
      w!.removedAt = iso;
      if (e.taken) w!.spare = true;
      return;
  }
}

// Which states refuse which events: each caller checks first, so never sends them.
const live = ['held', 'heldTorn', 'owed', 'owedTorn', 'spareOnly', 'emptyRemoved'];
const gone = ['removed', 'removedTorn', 'handedOn', 'removedStillOwed', 'handedOnStillOwed', 'oddTypes'];
const REFUSED: Record<string, string[]> = {
  made: live,
  madeArchived: live,
  owe: ['none', ...gone],
  tornDown: ['none'],
  toldTornDown: ['none'],
  cleanedStays: ['none'],
  cleanedRemoved: ['none'],
  cleanedHandedOn: ['none'],
  foundGone: ['none'],
  foundTaken: ['none'],
};
// emptyRemoved has cleanupOwed: false and an empty removedAt: held, as the code reads it.
const own = (r: object | undefined) => (r ? Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) : r);

test('the states read as their kinds', () => {
  const kinds = Object.fromEntries(Object.keys(STATES).map((s) => [s, slotOf(rec(s).worktree).kind]));
  assert.deepEqual(kinds, {
    none: 'none', held: 'held', heldTorn: 'held', owed: 'owed', owedTorn: 'owed', removed: 'removed', removedTorn: 'removed', handedOn: 'handedOn',
    removedStillOwed: 'removed', handedOnStillOwed: 'handedOn', spareOnly: 'held', emptyRemoved: 'held', oddTypes: 'handedOn',
  });
});

for (const [eventName, event] of Object.entries(EVENTS)) {
  test(`every state, on ${eventName}`, () => {
    for (const state of Object.keys(STATES)) {
      const mine = rec(state);
      const res = writeSlot(mine, event(), NOW);
      if ((REFUSED[eventName] ?? []).includes(state)) {
        assert.equal(res.ok, false, `${eventName} on ${state} is refused`);
        assert.deepEqual(mine, rec(state), 'and changes nothing');
        continue;
      }
      assert.ok(res.ok, `${eventName} on ${state}: ${res.ok ? '' : res.reason}`);
      const want = rec(state);
      byHand(want, event());
      assert.deepEqual(own(mine.worktree), own(want.worktree), `${eventName} on ${state}`);
      assert.equal(res.slot.kind, slotOf(mine.worktree).kind, 'the move says what the record now reads as');
    }
  });
}

// Every combination of these values for the four fields.
const VALUES: unknown[] = [undefined, true, false, '', PAST, 1, 'yes'];
function* shapes(): Generator<Raw> {
  const n = VALUES.length;
  for (let i = 0; i < n ** SLOT_FIELDS.length; i++) {
    const f: Raw = {};
    let x = i;
    for (const k of SLOT_FIELDS) {
      const v = VALUES[x % n];
      x = Math.floor(x / n);
      if (v !== undefined) f[k] = v;
    }
    yield f;
  }
}

test('every shape of the fields reads as a Slot and writes back as it was', () => {
  let count = 0;
  for (const f of shapes()) {
    const w = { ...W(), ...f } as WorktreeRecord;
    const back = slotFields(slotOf(w));
    for (const k of SLOT_FIELDS) assert.equal(back[k], (w as Raw)[k], `${k} of ${JSON.stringify(f)}`);
    count++;
  }
  assert.equal(count, VALUES.length ** SLOT_FIELDS.length);
});

test('thousands of random event sequences match the writes by hand, or are refused with nothing changed', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const all = [...shapes()];
  const names = Object.keys(EVENTS);
  let moves = 0;
  for (let run = 0; run < 3000; run++) {
    const start = rand() < 0.1 ? undefined : { ...W(), ...all[Math.floor(rand() * all.length)] } as WorktreeRecord;
    const mine: { worktree?: WorktreeRecord } = start ? { worktree: structuredClone(start) } : {};
    const want: { worktree?: WorktreeRecord } = start ? { worktree: structuredClone(start) } : {};
    for (let step = 0; step < 12; step++) {
      const name = names[Math.floor(rand() * names.length)];
      const kind = slotOf(mine.worktree).kind;
      const before = structuredClone(mine);
      const res = writeSlot(mine, EVENTS[name](), NOW + step);
      if (!res.ok) {
        assert.deepEqual(mine, before, `${name} refused on ${kind} changes nothing`);
        // Refused only where a caller would never send it.
        assert.ok(
          ((name === 'made' || name === 'madeArchived') && (kind === 'held' || kind === 'owed')) || (name === 'owe' && kind !== 'held' && kind !== 'owed') || kind === 'none',
          `${name} on ${kind}: ${res.reason}`,
        );
        continue;
      }
      const e = EVENTS[name]();
      // The hand writes, at the same moment.
      const iso = new Date(NOW + step).toISOString();
      byHand(want, e, iso);
      assert.deepEqual(own(mine.worktree), own(want.worktree), `${name} at step ${step} of run ${run}`);
      moves++;
    }
  }
  assert.ok(moves > 20_000, `${moves} moves`);
});

test("what the machine keeps true: a live worktree is never replaced, and a handed-on one is never the thread's again", () => {
  for (const state of Object.keys(STATES)) {
    const kind = slotOf(rec(state).worktree).kind;
    for (const [name, event] of Object.entries(EVENTS)) {
      const res = moveSlot(slotOf(rec(state).worktree), event(), NOW);
      if (!res.ok) continue;
      if (kind === 'held' || kind === 'owed') assert.ok(!(name === 'made' || name === 'madeArchived'), `${name} replaced a live worktree`);
      if (kind === 'handedOn' && !name.startsWith('made') && !name.startsWith('arrived')) assert.equal(res.slot.kind, 'handedOn', `${name} took a handed-on folder back`);
      if (kind === 'removed' && !name.startsWith('made') && !name.startsWith('arrived')) assert.ok(res.slot.kind === 'removed' || res.slot.kind === 'handedOn', `${name} brought a removed one back`);
    }
  }
});

test('an unchanged field keeps its place: writing a move touches only what changes', () => {
  const mine = { worktree: { ...W(), cleanupOwed: true, tornDownAt: PAST } as WorktreeRecord };
  writeSlot(mine, { kind: 'tornDown' }, NOW);
  assert.deepEqual(Object.keys(mine.worktree), [...Object.keys(W()), 'cleanupOwed', 'tornDownAt']);
  // A slow cleanup's worktree, replaced on the record meanwhile: its own
  // fields are written, as before, and the record's new one is left alone.
  const old = mine.worktree;
  mine.worktree = FRESH();
  writeSlot(mine, { kind: 'cleaned', removed: true }, NOW, old);
  assert.equal(old.removedAt, ISO);
  assert.equal(mine.worktree.removedAt, undefined);
});

// ---- The folder ----

const snap = (s: Partial<SlotSnapshot>): SlotSnapshot => ({ path: 'p', folder: true, records: [], ...s });
const claim = (thread: string, branch = `thread/${thread}`, archived = false) => ({ thread, branch, archived });

test('what a folder is, from its snapshot', () => {
  const cases: [Partial<SlotSnapshot>, string][] = [
    [{ folder: false, branch: 'thread/aaaaaaaa', records: [claim('aaaaaaaa')] }, 'missing'],
    [{ locked: 'threadbear spare' }, 'spare'],
    [{ locked: 'threadbear spare', records: [claim('aaaaaaaa')] }, 'spare'],
    [{ locked: 'mine' }, 'locked'],
    [{ locked: '' }, 'locked'],
    [{ branch: 'thread/aaaaaaaa', records: [claim('aaaaaaaa'), claim('bbbbbbbb', 'thread/aaaaaaaa')] }, 'twoHolders'],
    [{ branch: 'thread/aaaaaaaa', records: [claim('aaaaaaaa')] }, 'held'],
    [{ branch: 'thread/aaaaaaaa', records: [claim('aaaaaaaa', 'thread/aaaaaaaa', true)] }, 'held'],
    [{ landing: true, records: [claim('aaaaaaaa')] }, 'landing'],
    [{ records: [claim('aaaaaaaa')] }, 'taken'],
    [{ branch: 'thread/borrow-slot-1-x', records: [claim('aaaaaaaa')] }, 'taken'],
    [{ branch: 'thread/borrow-slot-1-x' }, 'borrowed'],
    [{ branch: 'thread/borrow-slot-1-x', borrower: { thread: 't' } }, 'borrowed'],
    [{}, 'loose'],
    [{ landing: true }, 'loose'],
    [{ branch: 'thread/cccccccc' }, 'leftBehind'],
    [{ branch: 'thread/gpui-menus' }, 'byHand'],
    [{ branch: 'main-spike' }, 'byHand'],
  ];
  for (const [s, kind] of cases) assert.equal(slotOnDisk(snap(s)).kind, kind, JSON.stringify(s));
});

// The borrow sweep's pick, as it was by hand before slotOnDisk: a checkout
// that isn't locked and is on a borrow branch or detached, and that no
// thread's worktree or open thread's folder is in.
test("the borrow sweep's candidates are the borrowed and loose folders, as by hand", () => {
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  for (let i = 0; i < 5000; i++) {
    const records = rand() < 0.5 ? [] : rand() < 0.8 ? [claim('aaaaaaaa', pick(['thread/aaaaaaaa', 'thread/borrow-x']), rand() < 0.5)] : [claim('aaaaaaaa'), claim('bbbbbbbb')];
    const s = snap({
      folder: rand() < 0.95,
      ...(rand() < 0.6 ? { branch: pick(['thread/aaaaaaaa', 'thread/borrow-x', 'thread/cccccccc', 'spike']) } : {}),
      ...(rand() < 0.3 ? { locked: pick(['threadbear spare', '', 'other']) } : {}),
      ...(rand() < 0.2 ? { landing: true } : {}),
      records,
    });
    // An open thread's folder inside it counts as held too.
    const cwdInside = rand() < 0.2;
    const held = records.length > 0 || cwdInside;
    const byHandPick = s.folder && s.locked === undefined && (!s.branch || s.branch.startsWith('thread/borrow-')) && !held;
    const kind = slotOnDisk(s).kind;
    assert.equal((kind === 'borrowed' || kind === 'loose') && !cwdInside, byHandPick, JSON.stringify(s));
  }
});

// The guard: nothing outside slot.ts writes a thread's worktree or its
// four lifecycle fields.
test("only slot.ts writes a thread's worktree and where it is in its life", () => {
  const src = path.resolve(import.meta.dirname, '../../src');
  const fields = [...SLOT_FIELDS, 'worktree'].join('|');
  const write = new RegExp(`(?:delete\\s+([\\w.!?\\[\\]]+?)\\.(${fields})\\b)|(?:([\\w.!?\\[\\]]+?)\\.(${fields})\\s*(?:=(?!=)|\\?\\?=|\\|\\|=|&&=))`, 'g');
  // file: the receivers in it that aren't a thread's record or its worktree.
  const notRecords: Record<string, string[]> = {
    'runner.ts': ['s'], // summary()
    'patches.ts': ['loaded'], // a patch's worktree settings
    'runner/warm-start.ts': ['this'], // the runner's spare CLI, no slot
    // moves.ts: the staged placement, read back as the record's worktree
    // through writeSlot's arrived.
    'runner/moves.ts': ['placed'],
  };
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && e.name !== 'slot.ts') {
        const rel = path.relative(src, p).split(path.sep).join('/');
        const text = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        for (const m of text.matchAll(write)) {
          const receiver = (m[1] ?? m[3]).split('.').at(-1)!;
          if (!(notRecords[rel] ?? []).includes(receiver)) found.push(`${rel}: ${m[0]}`);
        }
      }
    }
  };
  walk(src);
  assert.deepEqual(found, [], `A thread's worktree and its ${SLOT_FIELDS.join(', ')} are written only by writeSlot in src/slot.ts. ` +
    'Send it an event (add one to SlotEvent and moveSlot if none fits) rather than setting or deleting the field. ' +
    "If the object written isn't a thread's record or its worktree, add its name to notRecords in this test.");
});
