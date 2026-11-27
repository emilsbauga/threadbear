// node --test web/src/sections.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { archived, archiveShown, build, clampWidth, hibernating, isFiltering, isSnoozed, matches, neighbour, NO_FILTER, passes, placeChoices, readFolded, readOrder, readWidth, SECTIONS, shows, SIDEBAR_DEFAULT, SIDEBAR_MIN, urgency, wakeLine, wakesOf, type ThreadRow } from './sections.ts';

const NOW = Date.parse('2026-11-05T10:00:00Z');
let n = 0;
const row = (over: Partial<ThreadRow> = {}): ThreadRow => ({ threadId: `t${++n}`, runnerId: 'mac', title: 'A thread', preview: '', cwd: '/Users/me/dev/acme', status: 'idle', needsYou: false, unread: false, lastActivityMs: NOW - 1000 * n, ...over });
const LANTERN = 'project\nmac\np';
const ACME = 'folder\nacme';
const ids = (rows: ThreadRow[]) => rows.map((r) => r.threadId);
const none = new Map<string, number>();

test('each thread goes in the heading the Mac puts it under', () => {
  const asks = row({ needs: 'you', asks: [{ ticked: false }] });
  const answer = row({ status: 'waiting', working: 'a job' });
  const busy = row({ status: 'running' });
  const background = row({ working: 'sub-agents' });
  const plain = row();
  const star = row({ starredAt: '2026-11-01T00:00:00Z', status: 'running' });
  const starAsleep = row({ starredAt: '2026-11-02T00:00:00Z', snoozedUntilRestart: true });
  const asleep = row({ snoozedUntil: '2026-11-06T00:00:00Z' });
  const gone = row({ archivedAt: '2026-11-01T00:00:00Z' });
  const s = build([asks, answer, busy, background, plain, star, starAsleep, asleep, gone], NOW, none, 'needsYou');
  assert.deepEqual(ids(s.starred), ids([star, starAsleep]));
  assert.deepEqual(new Set(ids(s.inbox)), new Set(ids([asks, answer, plain])));
  assert.deepEqual(new Set(ids(s.running)), new Set(ids([busy, background])));
  assert.deepEqual(s.scheduled, []);
});

test('a snooze that has passed is back in the inbox', () => {
  const r = row({ snoozedUntil: '2026-11-05T09:00:00Z' });
  assert.deepEqual(ids(build([r], NOW, none, 'needsYou').inbox), [r.threadId]);
});

test('idle with a schedule due goes under Hibernating, unless it wants Mike', () => {
  const idle = row();
  const wanting = row({ needs: 'you' });
  const wakes = wakesOf([
    { threadId: idle.threadId, nextRunAt: '2026-11-05T11:00:00Z' },
    { threadId: wanting.threadId, nextRunAt: '2026-11-05T11:00:00Z' },
  ]);
  const s = build([idle, wanting], NOW, wakes, 'needsYou');
  assert.deepEqual(ids(s.scheduled), [idle.threadId]);
  assert.deepEqual(ids(s.inbox), [wanting.threadId]);
});

test('paused and finished schedules wake nothing, and the soonest counts', () => {
  const wakes = wakesOf([
    { threadId: 'a', nextRunAt: '2026-11-05T11:00:00Z', paused: true },
    { threadId: 'b', nextRunAt: '2026-11-05T11:00:00Z', finishedAt: '2026-11-05T00:00:00Z' },
    { threadId: 'c', nextRunAt: '2026-11-05T12:00:00Z' },
    { threadId: 'c', nextRunAt: '2026-11-05T11:00:00Z' },
    { nextRunAt: '2026-11-05T11:00:00Z' },
  ]);
  assert.deepEqual([...wakes.keys()], ['c']);
  assert.equal(wakes.get('c'), Date.parse('2026-11-05T11:00:00Z'));
});

test('Hibernating is soonest to wake first, back on restart last, each once', () => {
  const scheduled = row();
  const soon = row({ snoozedUntil: '2026-11-05T10:30:00Z' });
  const restart = row({ snoozedUntilRestart: true });
  const wakes = new Map([[scheduled.threadId, Date.parse('2026-11-05T11:00:00Z')]]);
  assert.deepEqual(ids(hibernating([scheduled], [restart, soon, scheduled], wakes)), ids([soon, scheduled, restart]));
});

test('the inbox sorts by what needs Mike, newest or oldest', () => {
  const old = row({ lastActivityMs: NOW - 5000 });
  const failedRead = row({ status: 'error', lastActivityMs: NOW - 4000 });
  const unread = row({ needsYou: true, unread: true, lastActivityMs: NOW - 3000 });
  const asked = row({ status: 'waiting', lastActivityMs: NOW - 2000 });
  const fresh = row({ lastActivityMs: NOW - 1000 });
  const all = [old, failedRead, unread, asked, fresh];
  assert.deepEqual(ids(build(all, NOW, none, 'needsYou').inbox), ids([asked, unread, failedRead, fresh, old]));
  // A card waiting on Mike goes first in every order: it runs out (19 Nov).
  assert.deepEqual(ids(build(all, NOW, none, 'newest').inbox), ids([asked, fresh, unread, failedRead, old]));
  assert.deepEqual(ids(build(all, NOW, none, 'oldest').inbox), ids([asked, old, failedRead, unread, fresh]));
});

test('urgency: a failure that wants Mike outranks a plain one', () => {
  assert.equal(urgency(row({ needsYou: true, unread: true, status: 'error' })), 1);
  assert.equal(urgency(row({ needsYou: true, unread: true })), 2);
  assert.equal(urgency(row({ status: 'stopped' })), 3);
  assert.equal(urgency(row()), 4);
});

// The legacy rule, for rows without waitState: the cases the Mac and phone
// ran (app/Sources/ThreadbearCore/Threads/InboxUrgency.swift).
test('without waitState, urgency and the Needs you filter follow the old shared cases', () => {
  type Case = { name: string; thread: { status?: ThreadRow['status']; needsYou?: boolean; unread?: boolean; pendingReviews?: number }; urgency: number; counted: boolean };
  const file = new URL('../../shared/cases/inbox-urgency.json', import.meta.url);
  const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: Case[] };
  assert.ok(cases.length >= 9);
  for (const c of cases) {
    const r = row({ status: c.thread.status ?? 'idle', needsYou: c.thread.needsYou ?? false, unread: c.thread.unread ?? false, ...(c.thread.pendingReviews ? { pendingReviews: c.thread.pendingReviews } : {}) });
    assert.equal(urgency(r), c.urgency, c.name);
    assert.equal(passes(r, { show: 'needsYou' }, NOW), c.counted, c.name);
  }
});

// What the runner sends as waitState, drawn into the section, the Needs you
// order and the filter: the cases every app and the runner run
// (runner/src/wait-state.ts).
test('waitState is drawn into its section, urgency and the Needs you filter', () => {
  type Case = { name: string; thread: Partial<ThreadRow> & Record<string, unknown>; scheduled?: boolean; state: string; section: string; urgency: number; counted: boolean };
  const file = new URL('../../shared/cases/wait-states.json', import.meta.url);
  const { cases, now } = JSON.parse(readFileSync(file, 'utf8')) as { cases: Case[]; now: string };
  const at = Date.parse(now);
  assert.ok(cases.length >= 30);
  for (const c of cases) {
    const r = row({ ...c.thread, status: c.thread.status ?? 'idle', waitState: c.state } as Partial<ThreadRow>);
    const wakes = c.scheduled ? new Map([[r.threadId, at + 3_600_000]]) : none;
    const s = build([r], at, wakes, 'needsYou');
    const has = (rows: ThreadRow[]) => rows.some((x) => x.threadId === r.threadId);
    let section: string;
    if (has(s.starred)) section = 'starred';
    else if (has(s.inbox)) section = 'inbox';
    else if (has(s.running)) section = 'running';
    else if (has(s.scheduled)) section = 'hibernating';
    else if (r.archivedAt) {
      assert.ok(has(archived([r])), c.name);
      section = 'archived';
    } else {
      // Skipped as snoozed: the backend's Hibernating list draws it.
      assert.ok(isSnoozed(r, at), `${c.name}: skipped without a snooze`);
      assert.ok(has(hibernating(s.scheduled, [r], wakes)), c.name);
      section = 'hibernating';
    }
    assert.equal(section, c.section, c.name);
    assert.equal(urgency(r), c.urgency, c.name);
    assert.equal(passes(r, { show: 'needsYou' }, at), c.counted, c.name);
  }
});

test('an unknown waitState is drawn as done', () => {
  const r = row({ waitState: 'somethingNew', status: 'running', needsYou: true });
  assert.deepEqual(ids(build([r], NOW, none, 'needsYou').inbox), [r.threadId]);
  assert.equal(urgency(r), 4);
  assert.ok(!passes(r, { show: 'needsYou' }, NOW));
  assert.equal(urgency(row({ waitState: 'somethingNew', status: 'error' })), 3);
});

test('waitState wins over the fields the legacy rule reads', () => {
  // The runner says it waits on other threads: Running, though snoozed.
  const onThreads = row({ waitState: 'onThreads', snoozedUntil: '2026-11-06T00:00:00Z', needsYou: true });
  // Says done, though the old rule would call it a card.
  const done = row({ waitState: 'done', status: 'waiting' });
  // Says card: first in every order, even oldest first.
  const card = row({ waitState: 'card', status: 'waiting', lastActivityMs: NOW });
  const old = row({ waitState: 'done', lastActivityMs: NOW - 99_000 });
  const s = build([onThreads, done, card, old], NOW, none, 'oldest');
  assert.deepEqual(ids(s.running), [onThreads.threadId]);
  assert.deepEqual(ids(s.inbox), ids([card, old, done]));
  assert.ok(!passes(done, { show: 'needsYou' }, NOW));
  assert.ok(!passes(onThreads, { show: 'needsYou' }, NOW));
  // A read thread with open asks counts now (Mike, 23 Nov).
  assert.ok(passes(row({ waitState: 'needsYou', needs: 'you', asks: [{}] }), { show: 'needsYou' }, NOW));
});

test('stars stay in the order they were starred', () => {
  const second = row({ starredAt: '2026-11-02T00:00:00Z', lastActivityMs: NOW });
  const first = row({ starredAt: '2026-11-01T00:00:00Z', lastActivityMs: NOW - 9000 });
  assert.deepEqual(ids(build([second, first], NOW, none, 'needsYou').starred), ids([first, second]));
});

test('archived threads go most recently archived first', () => {
  const a = row({ archivedAt: '2026-11-01T00:00:00Z' });
  const b = row({ archivedAt: '2026-11-03T00:00:00Z' });
  assert.deepEqual(ids(archived([a, b])), ids([b, a]));
});

test('search looks in the title, last reply and place, ignoring case and accents', () => {
  const r = row({ title: 'Fix the Café menu', preview: 'Landed the change', projects: [{ id: 'p', title: 'Lets Build It' }] });
  assert.ok(matches(r, 'cafe'));
  assert.ok(matches(r, '  LANDED '));
  assert.ok(matches(r, 'build'));
  assert.ok(matches(r, ''));
  assert.ok(!matches(r, 'acme'), 'a thread in a project is known by the project, not its folder');
  assert.ok(matches(row({ cwd: '/Users/me/dev/acme/' }), 'acme'));
  assert.ok(!matches(r, 'nothing like it'));
});

test('filters pick out what needs Mike, unread, shared, and a place', () => {
  const asked = row({ needs: 'you' });
  const question = row({ status: 'waiting' });
  const unread = row({ unread: true });
  const shared = row({ share: { access: 'link' } });
  const stopped = row({ share: { access: 'none' } });
  const inProject = row({ projects: [{ id: 'p', title: 'Lantern' }] });
  const all = [asked, question, unread, shared, stopped, inProject];
  const of = (f: Parameters<typeof passes>[1]) => ids(all.filter((r) => passes(r, f)));
  assert.deepEqual(of(NO_FILTER), ids(all));
  assert.deepEqual(of({ show: 'needsYou' }), ids([asked, question]));
  assert.deepEqual(of({ show: 'unread' }), ids([unread]));
  assert.deepEqual(of({ show: 'shared' }), ids([shared]));
  assert.deepEqual(of({ show: 'all', place: LANTERN }), ids([inProject]));
  assert.deepEqual(of({ show: 'unread', place: ACME }), ids([unread]));
  assert.ok(!isFiltering(NO_FILTER));
  assert.ok(isFiltering({ show: 'all', place: LANTERN }));
});

test('a thread put away never needs Mike or counts as unread', () => {
  const gone = row({ archivedAt: '2026-11-01T00:00:00Z', needs: 'you', needsYou: true, unread: true });
  const asleep = row({ snoozedUntil: '2026-11-06T00:00:00Z', needsYou: true, unread: true });
  const woken = row({ snoozedUntil: '2026-11-05T09:00:00Z', needsYou: true, unread: true });
  for (const show of ['needsYou', 'unread'] as const) {
    assert.ok(!passes(gone, { show }, NOW), show);
    assert.ok(!passes(asleep, { show }, NOW), show);
    assert.ok(passes(woken, { show }, NOW), show);
  }
  assert.ok(passes(gone, { show: 'all', place: ACME }, NOW), 'a project filter still reaches them');
});

test('the open thread stays under a status filter, but not a search or another place', () => {
  const read = row({ title: 'Read now', projects: [{ id: 'p', title: 'Lantern' }] });
  assert.ok(!shows(read, '', { show: 'unread' }));
  assert.ok(shows(read, '', { show: 'unread' }, read.threadId));
  assert.ok(!shows(read, 'something else', { show: 'unread' }, read.threadId));
  assert.ok(!shows(read, '', { show: 'all', place: ACME }, read.threadId));
});

test('place choices count each thread once, most threads first', () => {
  const dupe = row({ projects: [{ id: 'p', title: 'Lantern' }] });
  const choices = placeChoices([dupe, dupe, row({ projects: [{ id: 'p', title: 'Lantern' }] }), row({ cwd: '/x/acme' })]);
  assert.deepEqual(choices, [
    { place: LANTERN, label: 'Lantern', count: 2 },
    { place: ACME, label: 'acme', count: 1 },
  ]);
});

// Daybreak 141: another runner's thread naming one of this runner's projects
// (its title, or its id) is another place, not in that project's filter.
test("another runner's thread with the same project title or id is a place of its own", () => {
  const mine = row({ projects: [{ id: 'p', title: 'Lantern' }] });
  const theirs = row({ runnerId: 'mini', projects: [{ id: 'p', title: 'Lantern' }] });
  const titled = row({ runnerId: 'mini', projects: [{ id: 'q', title: 'Lantern' }] });
  assert.deepEqual(ids([mine, theirs, titled].filter((r) => passes(r, { show: 'all', place: LANTERN }))), ids([mine]));
  assert.equal(placeChoices([mine, theirs, titled]).length, 3);
});

test('the archive shows a few, more on asking, every match while narrowing, and the open thread', () => {
  const rows = Array.from({ length: 30 }, () => row());
  assert.deepEqual([archiveShown(rows, 20, false).rows.length, archiveShown(rows, 20, false).more], [20, 10]);
  assert.deepEqual([archiveShown(rows, 70, false).rows.length, archiveShown(rows, 70, false).more], [30, 0]);
  assert.deepEqual([archiveShown(rows, 20, true).rows.length, archiveShown(rows, 20, true).more], [30, 0]);
  assert.equal(archiveShown(rows, 20, false, rows[24]!.threadId).rows.length, 25);
});

test('the arrow keys walk the drawn rows and stop at the ends', () => {
  const order = ['a', 'b', 'c'];
  assert.equal(neighbour(order, 'b', 1), 'c');
  assert.equal(neighbour(order, 'b', -1), 'a');
  assert.equal(neighbour(order, 'c', 1), undefined);
  assert.equal(neighbour(order, 'a', -1), undefined);
  assert.equal(neighbour(order, undefined, 1), 'a');
  assert.equal(neighbour(order, undefined, -1), 'c');
  assert.equal(neighbour(order, 'gone', 1), 'a');
});

test('folds start as the Mac does and survive a bad saved value', () => {
  assert.deepEqual([...readFolded(null)], ['hibernating', 'archived']);
  assert.deepEqual([...readFolded('not json')], ['hibernating', 'archived']);
  assert.deepEqual([...readFolded('[]')], []);
  assert.deepEqual([...readFolded('["inbox","nonsense"]')], ['inbox']);
});

test('the sort order falls back to needs you first', () => {
  assert.equal(readOrder(null), 'needsYou');
  assert.equal(readOrder('oldest'), 'oldest');
  assert.equal(readOrder('sideways'), 'needsYou');
});

test('the sidebar stays between its limits and leaves the thread room', () => {
  assert.equal(clampWidth(100, 1600), SIDEBAR_MIN);
  assert.equal(clampWidth(350.4, 1600), 350);
  assert.equal(clampWidth(5000, 2560), 600);
  assert.equal(clampWidth(5000, 900), 436);
  assert.equal(clampWidth(5000, 500), SIDEBAR_MIN);
  assert.equal(readWidth(null), SIDEBAR_DEFAULT);
  assert.equal(readWidth('banana'), SIDEBAR_DEFAULT);
  assert.equal(readWidth('410'), 410);
});

test('an unsent draft stays in Backlog even if starred, and first send leaves it', () => {
  const draft = row({ backlog: {text: 'Saved prompt', revision: 1, imageCount: 1}, starredAt: '2026-11-01T00:00:00Z' });
  const s = build([draft], NOW, none, 'needsYou');
  assert.deepEqual(ids(s.backlog), [draft.threadId]);
  assert.deepEqual(s.starred, []);
  assert.deepEqual(s.inbox, []);
  const {backlog: _saved, starredAt: _star, ...started} = draft;
  assert.deepEqual(ids(build([{...started, status: 'running'}], NOW, none, 'needsYou').running), [draft.threadId]);
});

test('a hibernating row that waits for more than a time says so first', () => {
  const now = Date.parse('2026-11-05T09:00:00Z');
  const r = row({ snoozedUntil: '2026-11-06T09:00:00Z', wakeNote: '"Convex I/O" finishes' });
  assert.equal(wakeLine(r, ['misc'], now), 'Until "Convex I/O" finishes · misc');
  assert.equal(wakeLine(row({ snoozedUntil: '2026-11-06T09:00:00Z' }), ['misc'], now), undefined);
  // Awake again: the note is stale.
  assert.equal(wakeLine(row({ wakeNote: 'the runner updates' }), ['misc'], now), undefined);
});


test('existing deferred conversations share Backlog without becoming unsent prompts', () => {
  const deferred = row({ backlogged: true });
  const s = build([deferred], NOW, new Map(), 'needsYou');
  assert.deepEqual(ids(s.backlog), [deferred.threadId]);
  assert.equal(s.inbox.length, 0);
});

test('coordinators stay before normal sections across waits and keep questions visible', () => {
  assert.deepEqual(SECTIONS.slice(0, 4), ['starred', 'coordinators', 'backlog', 'inbox']);
  const a = row({ coordinatorProjectId: 'p_a', waitState: 'hibernating', snoozedUntilRestart: true });
  const b = row({ coordinatorProjectId: 'p_b', waitState: 'card', needsYou: true, starredAt: '2026-11-01T00:00:00Z' });
  const gone = row({ coordinatorProjectId: 'p_c', archivedAt: '2026-11-01T00:00:00Z' });
  const plain = row();
  const split = build([b, gone, plain, a], NOW, none, 'newest');
  assert.deepEqual(ids(split.coordinators), ids([a, b]));
  assert.deepEqual(ids(split.inbox), ids([plain]));
  assert.deepEqual(split.starred, []);
  assert.equal(passes(b, { show: 'needsYou' }, NOW), true);
  assert.deepEqual(hibernating([], [a], none), []);
});

test('bad coordinator metadata keeps an ordinary thread visible', () => {
  for (const bad of ['', '  ', 12, {}, null]) {
    const r = row({ coordinatorProjectId: bad as string });
    const split = build([r], NOW, none, 'needsYou');
    assert.deepEqual(ids(split.inbox), [r.threadId]);
    assert.deepEqual(split.coordinators, []);
  }
});
