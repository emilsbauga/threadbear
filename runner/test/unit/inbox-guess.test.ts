// The inboxGuess experiment (runner/inbox-guess.ts; docs/protocol/threads.md,
// "Inbox guess"): a model guesses which finished threads Alex didn't need
// to see, his pick from the done card's Archive menu says whether it was
// right, and nothing is archived by the guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAccounts, FakeAdapter, makeHarness, testConfig, tmpDir } from '../helpers/fakes.ts';
import { Runner } from '../../src/runner.ts';
import { ThreadStore } from '../../src/store.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import type { GenerateParams, ModelResult } from '../../src/models/index.ts';
import { GUESS_CATCH_UP_MS, INBOX_GUESS_FILE, readGuess } from '../../src/runner/inbox-guess.ts';

const END_TURN = 'mcp__threadbear__end_turn';

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Long enough for a guess that was going to be made to have been.
const settle = () => new Promise((r) => setTimeout(r, 150));

type Answer = string | ModelResult<string>;

function setup(o: { on?: boolean; cheap?: Answer; strong?: Answer; hold?: Promise<void> } = {}) {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { inboxGuess: o.on !== false } }));
  const asked: GenerateParams[] = [];
  const models = {
    generate: async (p: GenerateParams): Promise<ModelResult<string>> => {
      if (p.feature !== 'inboxGuess') return { ok: false, reason: 'off', message: 'not the guess' };
      asked.push(p);
      if (o.hold) await o.hold;
      const a = (p.strong ? o.strong : o.cheap) ?? '{"guess":"skip","why":"It only did what he picked."}';
      return typeof a === 'string' ? { ok: true, value: a, model: p.strong ? 'claude-opus-5-5' : 'claude-haiku-5-5' } : a;
    },
  };
  const h = makeHarness(home, {}, { models });
  const lines = (): Array<Record<string, unknown>> => {
    const file = path.join(home, INBOX_GUESS_FILE);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  return { ...h, asked, lines };
}

type H = ReturnType<typeof setup>;

function finish(h: H, id: string, input: Record<string, unknown> = { needs: 'nothing' }, reply = 'Landed on main, and the setting is gone.') {
  const s = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: `e${Math.random()}`, name: END_TURN, kind: 'mcp', title: 'end_turn', input } });
  s.text(`m${Math.random()}`, reply);
  s.result('completed');
}

const mine = (h: H, text = 'Turn it on for everyone') => h.runner.create({ text, accountId: 'claude-main' }).thread.id;
const notes = (h: H, id: string) => h.events(id).filter((e) => e.type === 'system.note').map((e) => String(e.text));

test('a finished thread of his own gets a guess from each model, written down and nothing more', async () => {
  const h = setup({ strong: '{"guess":"show","why":"It landed past failing tests, which he may want to know."}' });
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  const [line] = h.lines();
  assert.equal(line.kind, 'guess');
  assert.equal(line.threadId, id);
  assert.equal(typeof line.seq, 'number');
  assert.deepEqual(line.guesses, [
    { by: 'claude-haiku-5-5', skip: true, why: 'It only did what he picked.' },
    { by: 'claude-opus-5-5', skip: false, why: 'It landed past failing tests, which he may want to know.' },
  ]);
  // Each was shown what he asked and what came back, as data.
  assert.equal(h.asked.length, 2);
  assert.match(h.asked[0].prompt, /Turn it on for everyone/);
  assert.match(h.asked[0].prompt, /Landed on main, and the setting is gone\./);
  assert.equal(h.asked[0].cwd, h.runner.get(id).cwd, 'so a private folder is left alone');
  // A guess, not an act: it's still in the inbox, and the thread says nothing of it.
  await settle();
  assert.equal(h.runner.get(id).archivedAt, undefined);
  assert.deepEqual(notes(h, id), []);
});

test('off unless the experiment is on', async () => {
  const h = setup({ on: false });
  const id = mine(h);
  finish(h, id);
  await settle();
  assert.equal(h.asked.length, 0);
  assert.deepEqual(h.lines(), []);
  h.runner.update({ threadId: id, archived: true });
  assert.deepEqual(h.lines(), [], 'and his archives are not written down either');
});

test('follow-ups are his to see, whatever a model would say: no model is asked', async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id, { needs: 'nothing', next: ['Stop the Threadbear transcript jumping when a long reply arrives'] });
  await until(() => h.lines().length === 1, 'the guess written down');
  assert.deepEqual(h.lines()[0].guesses, [{ by: 'rule', skip: false, why: 'It suggested follow-ups.' }]);
  assert.equal(h.asked.length, 0);
});

test('a thread that asks him something is not guessed', async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id, { needs: 'you', asks: [{ question: 'Deploy it?' }] });
  await settle();
  assert.deepEqual(h.lines(), []);
});

test("a helper thread is not guessed: it archives itself already", async () => {
  const h = setup();
  const parent = mine(h);
  const child = h.runner.create({ text: 'Fix the panel reload', accountId: 'claude-main', startedBy: { kind: 'thread', label: 'Agent', threadId: parent } }).thread.id;
  finish(h, child);
  await until(() => Boolean(h.runner.get(child).archivedAt), 'the helper archived');
  await settle();
  assert.deepEqual(h.lines(), []);
});

test('a helper that stays in his inbox, for its follow-ups, is his to see by rule', async () => {
  const h = setup();
  const parent = mine(h);
  const child = h.runner.create({ text: 'Fix the panel reload', accountId: 'claude-main', startedBy: { kind: 'thread', label: 'Agent', threadId: parent } }).thread.id;
  finish(h, child, { needs: 'nothing', next: ['Stop the Threadbear transcript jumping when a long reply arrives'] });
  await until(() => h.lines().length === 1, 'the guess written down');
  assert.equal(h.runner.get(child).archivedAt, undefined);
  assert.deepEqual(h.lines()[0].guesses, [{ by: 'rule', skip: false, why: 'It suggested follow-ups.' }]);
  assert.equal(h.asked.length, 0);
});

test("another lab's review of a change is not guessed", async () => {
  const h = setup();
  const reviewed = mine(h);
  const review = mine(h, 'Review the change');
  h.runner.threads.get(review)!.rec.reviewOf = reviewed;
  finish(h, review);
  await settle();
  assert.deepEqual(h.lines().filter((l) => l.threadId === review), []);
  assert.equal(h.asked.length, 0);
});

test("his pick from Archive's menu is kept beside the guesses it answers", async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  h.runner.update({ threadId: id, archived: true, verdict: 'didntNeedToSee' });
  const t = h.runner.get(id);
  assert.equal(t.archiveVerdict, 'didntNeedToSee');
  assert.ok(notes(h, id).includes("Archived by you: didn't need to see this."));
  const line = h.lines()[1];
  assert.equal(line.kind, 'archive');
  assert.equal(line.threadId, id);
  assert.equal(line.label, 'skip');
  assert.equal(line.seq, h.lines()[0].seq, 'the same done card');
  assert.deepEqual(line.guesses, h.lines()[0].guesses);
});

test('"Glad I saw this" is the other label, and a plain archive has none', async () => {
  const h = setup();
  const a = mine(h);
  finish(h, a);
  const b = mine(h, 'How is the daily brief made?');
  finish(h, b);
  await until(() => h.lines().length === 2, 'both guesses');
  h.runner.update({ threadId: a, archived: true, verdict: 'gladISaw' });
  h.runner.update({ threadId: b, archived: true });
  const [glad, plain] = h.lines().slice(2);
  assert.equal(glad.label, 'show');
  assert.ok(notes(h, a).includes('Archived by you: glad to have seen this.'));
  assert.equal(plain.kind, 'archive');
  assert.equal(plain.threadId, b);
  assert.equal('label' in plain, false);
});

test('"Not sure" is kept as unsure, so scoring can leave it out', async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  h.runner.update({ threadId: id, archived: true, verdict: 'notSure' });
  assert.equal(h.runner.get(id).archiveVerdict, 'notSure');
  assert.ok(notes(h, id).includes('Archived by you: not sure you needed to see this.'));
  const line = h.lines()[1];
  assert.equal(line.kind, 'archive');
  assert.equal(line.label, 'unsure');
  assert.deepEqual(line.guesses, h.lines()[0].guesses);
});

test('only his own archives of a finished thread are written down', async () => {
  const h = setup();
  const id = mine(h);
  finish(h, id);
  await until(() => h.lines().length === 1, 'the guess written down');
  h.runner.update({ threadId: id, archived: true, archivedBy: 'agent' });
  assert.equal(h.lines().length, 1, "an agent's archive says nothing about what he needed to see");
  // One still waiting on him: archiving it says nothing about done threads.
  const asking = mine(h);
  finish(h, asking, { needs: 'you', asks: [{ question: 'Deploy it?' }] });
  await settle();
  h.runner.update({ threadId: asking, archived: true });
  assert.equal(h.lines().length, 1);
});

test('a guess for an earlier done card is not passed off as one for the latest', async () => {
  // The cheap model is out of room for the second turn: no guess for it.
  let room = true;
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { inboxGuess: true } }));
  const models = {
    generate: async (p: GenerateParams): Promise<ModelResult<string>> =>
      room && p.feature === 'inboxGuess' ? { ok: true, value: '{"guess":"skip","why":"A receipt."}', model: 'm' } : { ok: false, reason: 'no-room', message: 'none' },
  };
  const h = makeHarness(home, {}, { models });
  const lines = () => fs.readFileSync(path.join(home, INBOX_GUESS_FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const id = h.runner.create({ text: 'Turn it on', accountId: 'claude-main' }).thread.id;
  const end = (reply: string) => {
    const s = h.adapter.sessions.filter((x) => x.opts.threadId === id).at(-1)!;
    s.init();
    s.out({ kind: 'event', event: { type: 'tool.call', itemId: `e${Math.random()}`, name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
    s.text(`m${Math.random()}`, reply);
    s.result('completed');
  };
  end('Done.');
  await until(() => fs.existsSync(path.join(home, INBOX_GUESS_FILE)), 'the first guess');
  room = false;
  h.runner.send(id, 'And why did the tests fail?');
  end('Because the Windows box was out of disk.');
  await settle();
  h.runner.update({ threadId: id, archived: true, verdict: 'gladISaw' });
  const last = lines().at(-1)!;
  assert.equal(last.kind, 'archive');
  assert.equal(last.label, 'show');
  assert.equal('guesses' in last, false, 'the first card’s guess is not this card’s');
});

// The runner a new release starts, on the same data folder: it loads every
// thread but `skip` (the ones the old runner is still finishing), and
// adopts each of those as it's handed over.
function next(home: string, skip: string[], answer = '{"guess":"skip","why":"A receipt."}', clock = new FakeClock()) {
  const asked: GenerateParams[] = [];
  const runner = new Runner({
    config: testConfig(home),
    store: new ThreadStore(home),
    adapters: { claude: new FakeAdapter(), codex: new FakeAdapter('codex') },
    accounts: new FakeAccounts(),
    clock,
    log: nullLogger,
    defer: (fn) => fn(),
    copyTranscript: () => false,
    models: {
      generate: async (p: GenerateParams): Promise<ModelResult<string>> => {
        if (p.feature !== 'inboxGuess') return { ok: false, reason: 'off', message: 'not the guess' };
        asked.push(p);
        return { ok: true, value: answer, model: p.strong ? 'claude-opus-5-5' : 'claude-haiku-5-5' };
      },
    },
  });
  runner.start({ skip: new Set(skip) });
  return { runner, asked };
}

// A runner whose models never answer in time: the guess is still being
// made when the thread leaves it.
function slow() {
  let answer: (() => void) | undefined;
  const hold = new Promise<void>((r) => (answer = r));
  return { ...setup({ hold }), answer: () => answer!() };
}

test('a thread that finished on a runner handing over gets its guess from the new one', async () => {
  // Seven of his first sixteen answers had no guess beside them (19 Nov):
  // each thread had finished on the old runner during a release, and was
  // handed over half a second later, before the models had answered.
  const h = slow();
  const id = mine(h);
  finish(h, id, { needs: 'nothing' }, 'Landed on main, and the setting is gone.');
  await until(() => h.asked.length === 2, 'the old runner asking');
  await h.runner.letGo(h.runner.threads.get(id)!);
  const b = next(h.home, [id]);
  assert.equal(b.asked.length, 0);
  b.runner.adopt(id);
  await until(() => h.lines().length === 1, 'the guess written down');
  const [line] = h.lines();
  assert.equal(line.kind, 'guess');
  assert.equal(line.threadId, id);
  assert.deepEqual((line.guesses as Array<{ skip: boolean }>).map((g) => g.skip), [true, true]);
  // From the log: what he asked and the whole reply.
  assert.match(b.asked[0].prompt, /Turn it on for everyone/);
  assert.match(b.asked[0].prompt, /Landed on main, and the setting is gone\./);
  // The old runner's answer, arriving after it let go, writes nothing.
  h.answer();
  await settle();
  assert.equal(h.lines().length, 1);
  // And his pick is kept beside it.
  b.runner.update({ threadId: id, archived: true, verdict: 'didntNeedToSee' });
  assert.deepEqual(h.lines()[1].guesses, line.guesses);
});

test('its follow-ups come across too: by rule, with no model asked', async () => {
  const h = setup({ on: false });
  const id = mine(h);
  finish(h, id, { needs: 'nothing', next: ['Stop the Threadbear transcript jumping when a long reply arrives'] });
  await settle();
  await h.runner.letGo(h.runner.threads.get(id)!);
  fs.writeFileSync(path.join(h.home, 'runner.json'), JSON.stringify({ experiments: { inboxGuess: true } }));
  const b = next(h.home, [id]);
  b.runner.adopt(id);
  await until(() => h.lines().length === 1, 'the guess written down');
  assert.deepEqual(h.lines()[0].guesses, [{ by: 'rule', skip: false, why: 'It suggested follow-ups.' }]);
  assert.equal(b.asked.length, 0);
});

test("one that came across with its guess, or asking him something, isn't guessed again", async () => {
  const h = setup();
  const guessed = mine(h);
  finish(h, guessed);
  await until(() => h.lines().length === 1, 'the guess written down');
  const asking = mine(h);
  finish(h, asking, { needs: 'you', asks: [{ question: 'Deploy it?' }] });
  await settle();
  await h.runner.letGo(h.runner.threads.get(guessed)!);
  await h.runner.letGo(h.runner.threads.get(asking)!);
  const b = next(h.home, [guessed, asking]);
  b.runner.adopt(guessed);
  b.runner.adopt(asking);
  await settle();
  assert.equal(b.asked.length, 0);
  assert.equal(h.lines().length, 1);
});

test('a runner starting makes the guess a just-finished thread lost, and leaves older ones alone', async () => {
  // Idle threads go to the new runner at once, with whatever was being
  // worked out about them. Not every finished thread in the inbox, though:
  // that would be a model call for each, at every start.
  const h = slow();
  const fresh = mine(h);
  finish(h, fresh);
  const old = mine(h, 'How is the daily brief made?');
  finish(h, old);
  await until(() => h.asked.length === 4, 'the old runner asking');
  const at = Date.parse(h.runner.threads.get(fresh)!.rec.finished!.at);
  await h.runner.letGo(h.runner.threads.get(fresh)!);
  await h.runner.letGo(h.runner.threads.get(old)!);
  const file = path.join(h.home, 'threads', old, 'thread.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { finished: { at: string } };
  rec.finished.at = new Date(at - GUESS_CATCH_UP_MS - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(rec));
  const b = next(h.home, [], undefined, new FakeClock(at + 5_000));
  await until(() => h.lines().length === 1, 'the guess written down');
  await settle();
  assert.deepEqual(h.lines().map((l) => l.threadId), [fresh]);
  assert.equal(b.asked.length, 2);
});

test('reading a model’s answer: only a clear skip or show counts', () => {
  assert.deepEqual(readGuess('{"guess":"skip","why":"A receipt."}'), { skip: true, why: 'A receipt.' });
  assert.deepEqual(readGuess('```json\n{"guess":"show","why":"He asked a question."}\n```'), { skip: false, why: 'He asked a question.' });
  assert.equal(readGuess('I think skip'), undefined);
  assert.equal(readGuess('{"guess":"maybe","why":"x"}'), undefined);
  assert.equal(readGuess('{"guess":"skip"}'), undefined, 'a guess with no reason is no use when it turns out wrong');
});
