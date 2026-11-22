// Replies from a thread the main Mac started on another runner go back to
// the thread that started it (src/far-reports.ts): on 20 Nov a thread on
// the Pixel (a runner key) couldn't send_message its report to the M5
// thread that started it, and it never arrived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FarReports, farReportText, replyOf, turnsOf, type FarRow } from '../../src/far-reports.ts';
import { AGENT_MESSAGE_PREFIX, sentByAgent } from '../../src/protocol.ts';
import { senderPrefix } from '../../src/runner/nested.ts';
import { tmpDir } from '../helpers/fakes.ts';

const START = Date.parse('2026-11-20T10:00:00Z');
const MIN = 60_000;

// A far thread's rows for one turn, as the backend keeps them.
function turn(n: number, texts: string[], opts: { tools?: boolean; summary?: string } = {}): FarRow[] {
  const t = `t${n}`;
  const base = n * 100;
  return [
    { seq: base, role: 'user', text: 'go', turn: t },
    ...(opts.tools ? [{ seq: base + 1, role: 'assistant', text: 'Looking.', turn: t }, { seq: base + 2, role: 'tool', text: 'Ran tests', toolKind: 'command', turn: t }] : []),
    ...texts.map((text, i) => ({ seq: base + 10 + i, role: 'assistant', text, turn: t })),
    ...(opts.summary ? [{ seq: base + 40, role: 'tool', text: 'threadbear: end_turn', toolKind: 'mcp', turn: t }, { seq: base + 41, role: 'assistant', text: opts.summary, summary: true, turn: t }] : []),
  ];
}

function fake(dir = tmpDir('far-reports')) {
  const sent: { to: string; text: string }[] = [];
  const s = {
    row: { status: 'running', lastActivityAt: '2026-11-20T10:00:00Z', title: 'Check the "update"] (now)' } as { status: string; lastActivityAt?: string; title?: string } | null,
    rows: [] as FarRow[],
    here: new Set(['starter1']),
    active: true,
    now: START,
    rowReads: 0,
    failDeliver: false,
  };
  const make = () =>
    new FarReports({
      file: path.join(dir, 'far-reports.json'),
      row: async () => {
        s.rowReads++;
        return s.row;
      },
      rows: async () => s.rows,
      self: () => 'm5',
      runnerName: (id) => (id === 'cloud' ? 'Cloud box' : undefined),
      has: (id) => s.here.has(id),
      deliver: (to, text) => {
        if (s.failDeliver) throw new Error('busy');
        sent.push({ to, text });
      },
      active: () => s.active,
      log: { warn: () => {} },
      now: () => s.now,
    });
  const set = (status: string, at: string, rows: FarRow[]) => {
    s.row = { ...s.row!, status, lastActivityAt: at };
    s.rows = rows;
  };
  return { make, sent, s, set, tick: async (fr: FarReports, ms = 15_000) => ((s.now += ms), fr.tick()) };
}

test("each ended turn's reply goes to the starter once, after a second look finds it settled", async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'fa01aaaa-0000', runnerName: 'Pixel', starter: 'starter1' });
  f.set('running', '2026-11-20T10:00:00Z', turn(1, [], { tools: true }));
  await f.tick(fr);
  assert.equal(f.sent.length, 0, 'nothing while it works');
  // The row says it stopped before its last reply has reached the backend.
  f.set('idle', '2026-11-20T10:01:00Z', turn(1, [], { tools: true }));
  await f.tick(fr);
  f.s.rows = turn(1, ['Pixel is on cd605515e now.'], { tools: true, summary: '- On cd605515e' });
  await f.tick(fr);
  assert.equal(f.sent.length, 0, 'the turn changed since the first look, so it waits another');
  await f.tick(fr);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.to, 'starter1');
  assert.ok(sentByAgent(f.sent[0]!.text), "it reads as an agent's message, not Mike's");
  // The header ends as the app and nested.ts expect, whatever the title holds.
  assert.equal(f.sent[0]!.text.split('\n')[0], `${AGENT_MESSAGE_PREFIX}"Check the update now" (fa01aaaa)]`);
  assert.equal(senderPrefix(f.sent[0]!.text), 'fa01aaaa');
  assert.match(f.sent[0]!.text, /From Pixel, where this thread started it/);
  assert.match(f.sent[0]!.text, /\n\nPixel is on cd605515e now\.$/, 'the report, not end_turn\'s summary of it');
  await f.tick(fr);
  await f.tick(fr);
  assert.equal(f.sent.length, 1);
  // Two turns end between looks: both go, in order, the same words too.
  f.set('running', '2026-11-20T10:05:00Z', [...f.s.rows, ...turn(2, ['Same.'])]);
  await f.tick(fr);
  f.set('idle', '2026-11-20T10:07:00Z', [...f.s.rows, ...turn(3, ['Same.'])]);
  await f.tick(fr);
  assert.equal(f.sent.length, 2, 'the turn another followed goes at once');
  await f.tick(fr);
  assert.equal(f.sent.length, 3);
  assert.match(f.sent[2]!.text, /Same\.$/);
});

test('a reply that reached the backend after it was passed on follows', async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  f.set('idle', '2026-11-20T10:01:00Z', turn(1, [], { tools: true }));
  await f.tick(fr);
  await f.tick(fr);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /\(Its turn ended with no reply\.\)$/, 'narration before a command is no reply');
  f.s.rows = turn(1, ['The real report.'], { tools: true });
  await f.tick(fr);
  await f.tick(fr);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!.text, /again: more of it reached the backend[^]*The real report\.$/);
  await f.tick(fr);
  assert.equal(f.sent.length, 2);
});

test('a reply that fails to go is tried again; none go while inactive', async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  f.set('idle', '2026-11-20T10:01:00Z', turn(1, ['Done.']));
  f.s.active = false;
  await f.tick(fr);
  await f.tick(fr);
  assert.equal(f.s.rowReads, 0);
  f.s.active = true;
  f.s.failDeliver = true;
  await f.tick(fr);
  await f.tick(fr);
  assert.equal(f.sent.length, 0);
  f.s.failDeliver = false;
  await f.tick(fr);
  assert.equal(f.sent.length, 1);
});

test('kept across a restart, waits for a starter not here yet, and a quiet thread is looked at less often', async () => {
  const f = fake();
  f.make().add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  f.s.here.clear();
  f.set('idle', '2026-11-20T10:01:00Z', turn(1, ['Report.']));
  await f.tick(f.make());
  await f.tick(f.make());
  assert.equal(f.sent.length, 0);
  f.s.here.add('starter1');
  await f.tick(f.make());
  await f.tick(f.make());
  assert.equal(f.sent.length, 1);
  await f.tick(f.make());
  assert.equal(f.sent.length, 1, 'a new process sends nothing twice');
  const fr = f.make();
  await f.tick(fr, 31 * MIN);
  const reads = f.s.rowReads;
  await f.tick(fr);
  await f.tick(fr);
  assert.equal(f.s.rowReads, reads);
  await f.tick(fr, 5 * MIN);
  assert.equal(f.s.rowReads, reads + 1);
  // Its starter deleted: forgotten after a day.
  f.s.here.clear();
  await f.tick(fr, 25 * 60 * MIN);
  assert.deepEqual(fr.watching(), []);
});

test("a thread already watched keeps its starter, and one gone a month is forgotten", async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'other' });
  f.set('idle', '2026-11-20T10:01:00Z', turn(1, ['Report.']));
  f.s.here.add('other');
  await f.tick(fr);
  await f.tick(fr);
  assert.deepEqual(f.sent.map((s) => s.to), ['starter1']);
  f.s.row = null;
  await f.tick(fr, 31 * 24 * 60 * MIN);
  assert.deepEqual(fr.watching(), []);
});

test('a runner ending turns without end is capped at 40 replies a day', async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  const rows: FarRow[] = [];
  for (let n = 1; n <= 45; n++) {
    rows.push(...turn(n, [`reply ${n}`]));
    f.set('idle', `2026-11-20T10:${String(n).padStart(2, '0')}:00Z`, [...rows]);
    await f.tick(fr, 1000);
    await f.tick(fr, 1000);
  }
  assert.equal(f.sent.length, 40);
});

test("a turn's reply is its last words before the tool calls that end it", () => {
  assert.equal(replyOf(turn(1, ['Done: it works.', 'Also this.'], { tools: true }), 't1'), 'Done: it works.\n\nAlso this.');
  assert.equal(replyOf(turn(1, ['Report.'], { tools: true, summary: '- bullets' }), 't1'), 'Report.');
  assert.equal(replyOf(turn(1, [], { summary: '- bullets' }), 't1'), '- bullets');
  assert.equal(replyOf(turn(1, [], { tools: true }), 't1'), '(Its turn ended with no reply.)');
  assert.equal(replyOf(turn(1, []), 't1'), '(Its turn ended with no reply.)');
  assert.deepEqual(turnsOf([...turn(1, ['a']), ...turn(2, ['b'])]), ['t1', 't2']);
  assert.match(farReportText({ title: 'x', threadId: 'far1', runnerName: 'Pixel', reply: 'r'.repeat(30_000) }), /\[cut: read_thread far1 has the rest\]$/);
  assert.equal(farReportText({ title: 'x', threadId: 'far1', runnerName: 'Evil] [Mike says', reply: 'r' }).split('\n\n')[1], "From Evil Mike says, where this thread started it. Its reply as its turn ended, passed on by this Mac's runner (thread far1):");
});

test("catching up: every turn after the last one passed on goes, even when that one is off the page", async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  f.set('idle', '2026-11-20T10:01:00Z', turn(1, ['One.']));
  await f.tick(fr);
  await f.tick(fr);
  assert.equal(f.sent.length, 1);
  // Away a while: turn 1 has scrolled out of the newest rows.
  f.set('idle', '2026-11-20T11:00:00Z', [...turn(2, ['Two.']), ...turn(3, ['Three.'])]);
  await f.tick(fr);
  await f.tick(fr);
  assert.deepEqual(f.sent.slice(1).map((s) => s.text.split('\n\n').at(-1)), ['Two.', 'Three.']);
});

test("a turn whose last reply came only with the next turn's rows follows", async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  f.set('idle', '2026-11-20T10:01:00Z', turn(1, [], { tools: true }));
  await f.tick(fr);
  await f.tick(fr);
  f.set('running', '2026-11-20T10:02:00Z', [...turn(1, ['Real.'], { tools: true }), ...turn(2, [])]);
  await f.tick(fr);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!.text, /again[^]*Real\.$/);
});

test('a thread moved to this Mac is let go; one moved to another runner is followed there', async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerId: 'pixel', runnerName: 'Pixel', starter: 'starter1' });
  f.set('idle', '2026-11-20T10:01:00Z', turn(1, ['Report.']));
  f.s.row = { ...f.s.row!, runnerId: 'cloud' } as typeof f.s.row;
  await f.tick(fr);
  await f.tick(fr);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /From Cloud box,/);
  f.s.row = { ...f.s.row!, runnerId: 'm5' } as typeof f.s.row;
  await f.tick(fr);
  assert.deepEqual(fr.watching(), []);
});

test("a turn's late reply follows even when that turn fills the whole page", async () => {
  const f = fake();
  const fr = f.make();
  fr.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  const long = (end: FarRow[]): FarRow[] => [...Array.from({ length: 100 - end.length }, (_, i): FarRow => ({ seq: i, role: 'tool', text: 'Ran it', toolKind: 'command', turn: 't1' })), ...end];
  f.set('idle', '2026-11-20T10:01:00Z', long([]));
  await f.tick(fr);
  await f.tick(fr);
  f.s.rows = long([{ seq: 200, role: 'assistant', text: 'Real.', turn: 't1' }]);
  await f.tick(fr);
  await f.tick(fr);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1]!.text, /Real\.$/);
});

test("a handover's old runner, finishing a look late, doesn't undo what the new one passed on", async () => {
  const f = fake();
  const old = f.make();
  old.add({ threadId: 'far1', runnerName: 'Pixel', starter: 'starter1' });
  f.set('idle', '2026-11-20T10:01:00Z', turn(1, ['Report.']));
  await f.tick(old);
  // The old runner's next look waits on the backend while the new one sends.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = new FarReports({ ...(old as unknown as { deps: ConstructorParameters<typeof FarReports>[0] }).deps, row: async () => (await gate, f.s.row) });
  const late = (f.s.now += 15_000, slow.tick());
  const now = f.make();
  await f.tick(now);
  assert.equal(f.sent.length, 1);
  release();
  await late;
  await f.tick(now);
  await f.tick(now);
  assert.equal(f.sent.length, 1, 'sent once, by the new runner');
});

test("a turn's reply is its words before end_turn, not narration or what Mike changed", () => {
  const t = 't1';
  const rows = (...r: [string, string, boolean?][]): FarRow[] =>
    r.map(([role, text, summary], i) => ({ seq: i, role: role === 'mcp' ? 'tool' : role, text, turn: t, ...(role === 'mcp' ? { toolKind: 'mcp' } : role === 'tool' ? { toolKind: 'command' } : {}), ...(summary ? { summary } : {}) }));
  // Narration, a command, end_turn and its bullets: the bullets are the report.
  assert.equal(replyOf(rows(['user', 'go'], ['assistant', 'Let me look.'], ['tool', 'Ran it'], ['mcp', 'end_turn'], ['assistant', '- Found it', true]), t), '- Found it');
  // The report, a pin, end_turn and its bullets: the report.
  assert.equal(replyOf(rows(['user', 'go'], ['tool', 'Ran it'], ['assistant', 'The report.'], ['mcp', 'Pin x'], ['mcp', 'end_turn'], ['assistant', '- Found it', true]), t), 'The report.');
  // Mike wrote into the running turn: only what came after.
  assert.equal(replyOf(rows(['user', 'go'], ['assistant', 'Doing A.'], ['user', 'No, B.'], ['assistant', 'Did B.']), t), 'Did B.');
});
