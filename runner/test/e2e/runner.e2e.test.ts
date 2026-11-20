// Real end-to-end suite: starts the runner on a temp port and data dir and
// drives the real Claude CLI on the first Claude login that works (TB_E2E_ACCOUNT, src/test-login.ts) with the cheapest model,
// tiny prompts and a temp working folder. Run with `npm run test:e2e`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { RunnerClient } from '../../src/client.ts';
import { testLogin } from '../../src/test-login.ts';
import { checkSequence, checkSummary, isTransient } from '../helpers/protocol-check.ts';
import { makePng } from '../helpers/png.ts';

const ACCOUNT = testLogin();
const MODEL = process.env.TB_E2E_MODEL ?? 'claude-haiku-5-5';
const IDLE_MS = 6000;
const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

type Ev = Record<string, any>;

let root: string;
let home: string;
let cwd: string;
let runner: ChildProcess;
let client: RunnerClient;
let port = 0;
const events = new Map<string, Ev[]>(); // threadId -> every event seen (backlog + live)
const summaries = new Map<string, Ev>(); // threadId -> latest thread.updated
let runnerOutput = '';

async function startRunner(): Promise<void> {
  // Only this start's output: a stale "listening on" line from the previous
  // runner would point the client at a dead port.
  runnerOutput = '';
  runner = spawn(process.execPath, ['src/main.ts'], {
    cwd: RUNNER_DIR,
    env: {
      ...process.env,
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: '0',
      THREADBEAR_LOG: path.join(root, 'runner.log'),
      THREADBEAR_IDLE_MS: String(IDLE_MS),
      THREADBEAR_DEBUG: '1',
      THREADBEAR_CLI_UPDATES: 'off', THREADBEAR_TOKEN_TALLY: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  port = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`runner didn't start:\n${runnerOutput}`)), 15_000);
    runner.stdout!.on('data', (d) => {
      runnerOutput += d;
      const m = /listening on (\d+)/.exec(runnerOutput);
      if (m) {
        clearTimeout(t);
        resolve(Number(m[1]));
      }
    });
    runner.stderr!.on('data', (d) => (runnerOutput += d));
    runner.once('exit', (code) => reject(new Error(`runner exited ${code}:\n${runnerOutput}`)));
  });
  const token = fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();
  client = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, token);
  client.onNotification((method, params) => {
    if (method === 'thread.event') {
      const list = events.get(params.threadId) ?? [];
      list.push(params.event);
      events.set(params.threadId, list);
    } else if (method === 'thread.updated') {
      summaries.set(params.thread.id, params.thread);
    }
  });
  await client.call('hello', { client: 'e2e', version: '1' });
}

async function stopRunner(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  client?.close();
  if (runner.exitCode !== null) return;
  const exited = new Promise((r) => runner.once('exit', r));
  runner.kill(signal);
  await exited;
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function persisted(threadId: string): any[] {
  return (events.get(threadId) ?? []).filter((e) => !isTransient(e));
}

function turnDone(threadId: string, turnId: string, timeoutMs = 120_000): Promise<Ev> {
  return waitFor(`turn ${turnId}`, () => persisted(threadId).find((e) => e.type === 'turn.completed' && e.turnId === turnId), timeoutMs);
}

function turnEvents(threadId: string, turnId: string): any[] {
  return (events.get(threadId) ?? []).filter((e) => e.turnId === turnId);
}

function replyText(threadId: string, turnId: string): string {
  return turnEvents(threadId, turnId)
    .filter((e) => e.type === 'assistant.text')
    .map((e) => e.text)
    .join('\n');
}

async function createThread(params: Record<string, unknown>): Promise<{ id: string; turnId: string }> {
  const r = await client.call('threads.create', { accountId: ACCOUNT, model: MODEL, cwd, ...params });
  assert.deepEqual(checkSummary(r.thread), []);
  const sub = await client.call('threads.subscribe', { threadId: r.thread.id, afterSeq: 0 });
  // Live events may have landed before the subscribe reply; keep one copy.
  const live = events.get(r.thread.id) ?? [];
  const seen = new Set(sub.events.map((e: Ev) => e.seq));
  events.set(r.thread.id, [...sub.events, ...live.filter((e) => isTransient(e) || !seen.has(e.seq))]);
  return { id: r.thread.id, turnId: r.turnId };
}

function assertProtocol(threadId: string): void {
  const all = events.get(threadId) ?? [];
  assert.deepEqual(checkSequence(all), [], 'events follow docs/protocol.md');
}

describe('runner end to end (real Claude CLI)', { concurrency: false }, () => {
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-'));
    home = path.join(root, 'home');
    cwd = path.join(root, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'note.txt'), 'alpha\nbeta\ngamma\n');
    fs.writeFileSync(path.join(cwd, 'red.png'), makePng(64, 48, [220, 20, 20]));
    // Never the real data dir.
    assert.ok(!home.includes('Application Support/Threadbear'));
    await startRunner();
  });

  after(async () => {
    await stopRunner();
    if (process.env.TB_E2E_KEEP) console.log(`kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  });

  let main: { id: string; turnId: string };

  test('hello lists the test account', async () => {
    const hello = await client.call('hello', { client: 'e2e', version: '1' });
    assert.ok(hello.accounts.some((a: Ev) => a.id === ACCOUNT && a.title.includes('@')));
  });

  test('create a thread and stream a reply', async () => {
    main = await createThread({ text: 'Reply with exactly these words and nothing else: hello from threadbear' });
    const done = await turnDone(main.id, main.turnId);
    assert.equal(done.outcome, 'completed', done.error);
    assert.ok(done.costUsd > 0);
    const evs = turnEvents(main.id, main.turnId);
    const text = evs.find((e) => e.type === 'assistant.text');
    assert.match(text.text.toLowerCase(), /hello from threadbear/);
    const deltas = evs.filter((e) => e.type === 'assistant.text.delta' && e.itemId === text.itemId);
    assert.ok(deltas.length >= 1, 'streamed at least one delta');
    assert.ok(text.text.startsWith(deltas.map((d) => d.text).join('').slice(0, 5)));
    assertProtocol(main.id);
    const t = await waitFor('summary', () => summaries.get(main.id)?.status === 'idle' && summaries.get(main.id));
    assert.deepEqual(checkSummary(t), []);
    assert.equal(t.live, true);
    assert.equal(t.needsYou, true);
    assert.ok(t.nativeSessionId);
    assert.ok(t.contextTokens > 0);
    assert.equal(t.model, MODEL);
    assert.match(t.preview, /hello from threadbear/i);
    // First line of the first message, cut to 60 characters.
    assert.equal(t.title, 'Reply with exactly these words and nothing else: hello from');
    // runner.json names the port the runner is listening on, for the app.
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'runner.json'), 'utf8')).port, port);
  });

  test('use a tool: read a small file', async () => {
    const { turnId } = await client.call('threads.send', { threadId: main.id, text: 'Use the Read tool to read note.txt, then tell me its second line in one word.' });
    const done = await turnDone(main.id, turnId);
    assert.equal(done.outcome, 'completed', done.error);
    const evs = turnEvents(main.id, turnId);
    const call = evs.find((e) => e.type === 'tool.call' && e.name === 'Read');
    assert.ok(call, 'a Read tool call');
    assert.equal(call.kind, 'read');
    assert.equal(call.title, 'Read note.txt');
    const result = evs.find((e) => e.type === 'tool.result' && e.itemId === call.itemId);
    assert.equal(result.ok, true);
    assert.match(result.text, /beta/);
    assert.match(replyText(main.id, turnId), /beta/i);
    assertProtocol(main.id);
  });

  test('idle release stops the CLI, and the next send resumes the session', async () => {
    const before = summaries.get(main.id)!;
    await waitFor('idle release', () => summaries.get(main.id)?.live === false, IDLE_MS + 30_000);
    const { turnId } = await client.call('threads.send', { threadId: main.id, text: 'What was the second line of note.txt? Answer in one word.' });
    const done = await turnDone(main.id, turnId);
    assert.equal(done.outcome, 'completed', done.error);
    const evs = turnEvents(main.id, turnId);
    assert.ok(evs.some((e) => e.type === 'system.note' && e.text === 'Resumed session'));
    assert.match(replyText(main.id, turnId), /beta/i, 'the resumed session remembers the file');
    const after = await waitFor('summary', () => summaries.get(main.id)?.status === 'idle' && summaries.get(main.id));
    assert.equal(after.nativeSessionId, before.nativeSessionId);
    assert.ok(after.costUsd > before.costUsd);
    assertProtocol(main.id);
  });

  test('interrupt a long reply', async () => {
    const { turnId } = await client.call('threads.send', {
      threadId: main.id,
      text: 'Write the numbers from one to four hundred as English words, one per line, with nothing else.',
    });
    await waitFor('streaming', () => turnEvents(main.id, turnId).filter((e) => e.type === 'assistant.text.delta').length >= 3, 90_000);
    const t0 = Date.now();
    await client.call('threads.interrupt', { threadId: main.id });
    const done = await turnDone(main.id, turnId, 30_000);
    assert.equal(done.outcome, 'interrupted');
    assert.ok(Date.now() - t0 < 20_000, 'stopped promptly');
    const text = replyText(main.id, turnId);
    assert.ok(!/four hundred/i.test(text), 'did not finish the list');
    // The thread still works afterwards.
    const next = await client.call('threads.send', { threadId: main.id, text: 'Reply with just the word: ok' });
    const nextDone = await turnDone(main.id, next.turnId);
    assert.equal(nextDone.outcome, 'completed', nextDone.error);
    assertProtocol(main.id);
  });

  test('ask mode: approve a Write, see its diff first', async () => {
    const t = await createThread({
      permissionMode: 'ask',
      text: 'Use the Write tool to create hello.txt containing exactly the word hi. Do not use any other tool. Then say done.',
    });
    const req = await waitFor('approval', () => persisted(t.id).find((e) => e.type === 'approval.requested'));
    assert.equal(req.name, 'Write');
    assert.equal(req.title, 'Write hello.txt');
    assert.ok(req.options.includes('allow') && req.options.includes('deny'));
    const evs = persisted(t.id);
    const call = evs.find((e) => e.type === 'tool.call' && e.name === 'Write');
    const diff = evs.find((e) => e.type === 'edit.diff');
    assert.ok(call && diff, 'tool.call and edit.diff before the approval');
    assert.ok(evs.indexOf(call) < evs.indexOf(diff) && evs.indexOf(diff) < evs.indexOf(req));
    assert.equal(req.itemId, call.itemId);
    assert.deepEqual(diff.hunks[0].lines, ['+hi']);
    const waiting = await waitFor('waiting', () => summaries.get(t.id)?.status === 'waiting' && summaries.get(t.id));
    assert.equal(waiting.needsYou, true);
    assert.equal(fs.existsSync(path.join(cwd, 'hello.txt')), false, 'nothing written before approval');
    await client.call('approvals.respond', { threadId: t.id, approvalId: req.approvalId, decision: 'allow' });
    const done = await turnDone(t.id, t.turnId);
    assert.equal(done.outcome, 'completed', done.error);
    const resolved = persisted(t.id).find((e) => e.type === 'approval.resolved');
    assert.equal(resolved.decision, 'allow');
    const result = persisted(t.id).find((e) => e.type === 'tool.result' && e.itemId === call.itemId);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8').trim(), 'hi');
    assertProtocol(t.id);
    await client.call('threads.update', { threadId: t.id, archived: true });
  });

  test('AskUserQuestion surfaces as a question even in full mode', async () => {
    const t = await createThread({
      text: 'Use the AskUserQuestion tool to ask me whether I prefer tea or coffee (options Tea and Coffee). Then reply with only my choice.',
    });
    const q = await waitFor('question', () => persisted(t.id).find((e) => e.type === 'question.requested'));
    assert.equal(q.questions.length, 1);
    assert.deepEqual(q.questions[0].options.map((o: Ev) => o.label).sort(), ['Coffee', 'Tea']);
    await client.call('approvals.respond', { threadId: t.id, approvalId: q.approvalId, decision: 'answered', answers: { '0': 'Coffee' } });
    const done = await turnDone(t.id, t.turnId);
    assert.equal(done.outcome, 'completed', done.error);
    assert.match(replyText(t.id, t.turnId), /coffee/i);
    assert.equal(persisted(t.id).find((e) => e.type === 'approval.resolved').decision, 'answered');
    assertProtocol(t.id);
    await client.call('threads.update', { threadId: t.id, archived: true });
  });

  test('send an image, and get one back from a tool', async () => {
    const src = path.join(root, 'pasted.png');
    fs.writeFileSync(src, makePng(32, 32, [20, 40, 220]));
    const { image } = await client.call('media.import', { path: src });
    assert.ok(image.path.startsWith(path.join(home, 'inbox')));
    assert.deepEqual([image.mediaType, image.width, image.height], ['image/png', 32, 32]);
    const { turnId } = await client.call('threads.send', {
      threadId: main.id,
      text: 'What colour is the attached image? Answer in one word. Then use the Read tool on red.png and tell me its colour in one word too.',
      images: [image],
    });
    const done = await turnDone(main.id, turnId);
    assert.equal(done.outcome, 'completed', done.error);
    const evs = turnEvents(main.id, turnId);
    const um = evs.find((e) => e.type === 'user.message');
    assert.equal(um.images.length, 1);
    assert.ok(um.images[0].path.startsWith(path.join(home, 'threads', main.id, 'media')));
    assert.ok(fs.existsSync(um.images[0].path));
    const reply = replyText(main.id, turnId).toLowerCase();
    assert.match(reply, /blue/);
    assert.match(reply, /red/);
    const result = evs.find((e) => e.type === 'tool.result' && e.images.length > 0);
    assert.ok(result, 'the Read of red.png came back as an image');
    assert.ok(result.images[0].path.startsWith(path.join(home, 'threads', main.id, 'media')));
    assert.deepEqual([result.images[0].mediaType, result.images[0].width, result.images[0].height], ['image/png', 64, 48]);
    assertProtocol(main.id);
  });

  test('changing the folder carries the session there and resumes it', async () => {
    const before = summaries.get(main.id)!;
    const other = path.join(root, 'other');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'only-file.txt'), 'x\n');
    const r = await client.call('threads.update', { threadId: main.id, cwd: other });
    assert.equal(r.thread.cwd, other);
    const { turnId } = await client.call('threads.send', {
      threadId: main.id,
      text: 'Use the Bash tool to run ls in your current folder, then reply with the file name only.',
    });
    const done = await turnDone(main.id, turnId);
    assert.equal(done.outcome, 'completed', done.error);
    const evs = turnEvents(main.id, turnId);
    // Same account, so the transcript is copied across and resumed (a
    // handoff note is only for account changes or a missing transcript).
    assert.ok(evs.some((e) => e.type === 'system.note' && e.text.startsWith(`Moved to ${other}`)), JSON.stringify(evs.filter((e) => e.type === 'system.note')));
    assert.equal(evs.find((e) => e.type === 'user.message').text.startsWith('Use the Bash tool'), true, 'the transcript shows what was typed');
    assert.match(replyText(main.id, turnId), /only-file\.txt/);
    const after = await waitFor('summary', () => summaries.get(main.id)?.status === 'idle' && summaries.get(main.id));
    assert.equal(after.nativeSessionId, before.nativeSessionId, 'the same native session, resumed');
    assertProtocol(main.id);
  });

  test('tb CLI: new --wait, list, search and archive', async () => {
    const tb = (args: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        // Only THREADBEAR_HOME: tb finds the port in runner.json.
        const env: NodeJS.ProcessEnv = { ...process.env, THREADBEAR_HOME: home };
        delete env.THREADBEAR_PORT;
        execFile(process.execPath, [path.join(RUNNER_DIR, 'bin', 'tb'), ...args], { env, timeout: 120_000 }, (err, stdout, stderr) =>
          resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
        );
      });
    const made = await tb(['new', 'Reply with just the word: pong', '--cwd', cwd, '--account', ACCOUNT, '--model', MODEL, '--wait']);
    assert.equal(made.code, 0, made.out);
    assert.match(made.out, /pong/i);
    assert.match(made.out, /\(completed, /);
    const id = made.out.split('\n')[0].trim();
    assert.match(id, /^[0-9a-f-]{36}$/);
    const list = await tb(['list', '--json']);
    assert.ok(JSON.parse(list.out).some((t: Ev) => t.id === id));
    const found = await tb(['search', 'pong']);
    assert.match(found.out, new RegExp(id.slice(0, 8)));
    assert.equal((await tb(['archive', id.slice(0, 8)])).code, 0);
    const archived = await client.call('threads.list', { include: ['archived'] });
    assert.ok(archived.threads.some((t: Ev) => t.id === id));
  });

  test('archive releases the CLI; unarchive brings the thread back', async () => {
    const r = await client.call('threads.update', { threadId: main.id, archived: true });
    assert.ok(r.thread.archivedAt);
    await waitFor('released', () => summaries.get(main.id)?.live === false, 30_000);
    const archived = await client.call('threads.list', { include: ['archived'] });
    assert.ok(archived.threads.some((t: Ev) => t.id === main.id));
    const inbox = await client.call('threads.list', {});
    assert.ok(!inbox.threads.some((t: Ev) => t.id === main.id));
    // The title is the first 60 characters of the first message.
    const found = await client.call('threads.search', { query: 'exactly these words' });
    assert.ok(found.threads.some((t: Ev) => t.id === main.id));
    await client.call('threads.update', { threadId: main.id, archived: false });
    const back = await client.call('threads.list', {});
    assert.ok(back.threads.some((t: Ev) => t.id === main.id));
  });

  test('a background shell finishing starts a turn the thread shows, and a send goes into it', async () => {
    const t = await createThread({
      text: 'Use the Bash tool with run_in_background set to true to run: sleep 4 && echo BG-FINISHED . Do not wait for it or check on it. Reply with only: STARTED',
    });
    const first = await turnDone(t.id, t.turnId);
    assert.equal(first.outcome, 'completed', first.error);
    // The CLI starts a turn of its own when the job ends.
    const auto = await waitFor('CLI-started turn', () => persisted(t.id).find((e) => e.type === 'turn.started' && e.turnId !== t.turnId), 60_000);
    // Sent while that turn runs: it goes into that turn, which then lasts
    // until the message is answered (folded in, or run straight after).
    const { turnId: next } = await client.call('threads.send', { threadId: t.id, text: 'Reply with only the word: PINEAPPLE' });
    assert.equal(next, auto.turnId);
    const autoDone = await turnDone(t.id, auto.turnId);
    assert.equal(autoDone.outcome, 'completed', autoDone.error);
    const autoEvents = turnEvents(t.id, auto.turnId);
    const started = autoEvents.findIndex((e) => e.type === 'turn.started');
    const msg = autoEvents.findIndex((e) => e.type === 'user.message');
    assert.ok(msg > started, 'the message is shown inside the turn, after its start');
    assert.ok(autoEvents.some((e) => e.type === 'system.note' && /completed|finished/i.test(e.text)), 'a note says why it started');
    assert.match(replyText(t.id, next), /PINEAPPLE/);
    assert.equal(persisted(t.id).filter((e) => e.type === 'turn.completed').length, 2, 'one completion per turn');
    // Nothing landed outside a turn.
    assert.ok(persisted(t.id).every((e) => e.turnId), 'every event belongs to a turn');
    const s = await waitFor('summary', () => summaries.get(t.id)?.status === 'idle' && summaries.get(t.id));
    assert.equal(s.needsYou, true);
    assertProtocol(t.id);
    await client.call('threads.update', { threadId: t.id, archived: true });
  });

  test('a message sent during a turn goes into it and is answered by it', async () => {
    const t = await createThread({
      text: 'Use the Bash tool to run: sleep 5 . Then use the Bash tool again to run: sleep 5 . Then reply with only: DONE1',
    });
    await waitFor('first tool call', () => persisted(t.id).find((e) => e.type === 'tool.call' && e.turnId === t.turnId), 60_000);
    const { turnId } = await client.call('threads.send', { threadId: t.id, text: 'Reply with only the word: PINEAPPLE' });
    assert.equal(turnId, t.turnId, 'the running turn');
    const shown = await waitFor('message shown', () => persisted(t.id).filter((e) => e.type === 'user.message').at(1), 5_000);
    assert.equal(shown.turnId, t.turnId);
    assert.ok(!persisted(t.id).some((e) => e.type === 'turn.completed'), 'shown while the turn still runs');
    const done = await turnDone(t.id, t.turnId);
    assert.equal(done.outcome, 'completed', done.error);
    assert.match(replyText(t.id, t.turnId), /PINEAPPLE/);
    assert.equal(persisted(t.id).filter((e) => e.type === 'turn.completed').length, 1);
    assert.ok(persisted(t.id).every((e) => e.turnId), 'every event belongs to a turn');
    const s = await waitFor('summary', () => summaries.get(t.id)?.status === 'idle' && summaries.get(t.id));
    assert.equal(s.needsYou, true);
    assertProtocol(t.id);
    await client.call('threads.update', { threadId: t.id, archived: true });
  });

  test('Stop cancels a message sent during the turn too', async () => {
    const t = await createThread({ text: 'Use the Bash tool to run: sleep 12 . Then reply with only: DONE1' });
    await waitFor('tool call', () => persisted(t.id).find((e) => e.type === 'tool.call' && e.turnId === t.turnId), 60_000);
    await client.call('threads.send', { threadId: t.id, text: 'Reply with only the word: PINEAPPLE' });
    await client.call('threads.interrupt', { threadId: t.id });
    const done = await turnDone(t.id, t.turnId);
    assert.equal(done.outcome, 'interrupted');
    // Nothing runs after: the thread stays idle and no new turn starts.
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(persisted(t.id).filter((e) => e.type === 'turn.started').length, 1, 'no turn for the cancelled message');
    assert.ok(!/PINEAPPLE/.test(replyText(t.id, t.turnId)));
    assert.equal(summaries.get(t.id)?.status, 'idle');
    assert.ok(persisted(t.id).every((e) => e.turnId), 'every event belongs to a turn');
    assertProtocol(t.id);
    await client.call('threads.update', { threadId: t.id, archived: true });
  });

  test('snoozing with a background job running stops it at once and says so', async () => {
    const marker = path.join(cwd, 'bg-late.txt');
    const t = await createThread({
      text: 'Use the Bash tool with run_in_background set to true to run: sleep 37 && touch bg-late.txt . Do not wait for it or check on it. Reply with only: STARTED',
    });
    const done = await turnDone(t.id, t.turnId);
    assert.equal(done.outcome, 'completed', done.error);
    await new Promise((r) => setTimeout(r, IDLE_MS + 2000));
    assert.equal(summaries.get(t.id)?.live, true, 'not released at the idle time while the job runs');
    const t0 = Date.now();
    await client.call('threads.update', { threadId: t.id, snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    await waitFor('released', () => summaries.get(t.id)?.live === false, 15_000);
    assert.ok(Date.now() - t0 < 8000, `released promptly (${Date.now() - t0} ms)`);
    const note = persisted(t.id).find((e) => e.type === 'system.note' && /Stopped background work/.test(e.text));
    assert.ok(note, 'a note says the job was stopped');
    await new Promise((r) => setTimeout(r, 2000));
    const ps = await new Promise<string>((r) => execFile('/bin/ps', ['-axo', 'command='], (_e, out) => r(String(out))));
    assert.ok(!ps.split('\n').some((l) => l.trim() === 'sleep 37'), 'the job is gone');
    assert.equal(persisted(t.id).at(-1), note, 'nothing ran in the snoozed thread afterwards');
    assert.equal(fs.existsSync(marker), false);
    assertProtocol(t.id);
    await client.call('threads.update', { threadId: t.id, archived: true });
  });

  test('ask mode: "Always allow" lasts for the thread, changes nothing else, and writes no settings file', async () => {
    const dir = path.join(root, 'allow');
    fs.mkdirSync(dir, { recursive: true });
    const t = await createThread({ cwd: dir, permissionMode: 'ask', text: 'Use the Bash tool to run exactly: touch first.txt . Then reply with only: done' });
    const req = await waitFor('approval', () => persisted(t.id).find((e) => e.type === 'approval.requested'));
    assert.ok(req.options.includes('allowAlways'));
    await client.call('approvals.respond', { threadId: t.id, approvalId: req.approvalId, decision: 'allowAlways' });
    const done = await turnDone(t.id, t.turnId);
    assert.equal(done.outcome, 'completed', done.error);
    assert.equal(fs.existsSync(path.join(dir, '.claude', 'settings.local.json')), false, 'nothing saved in the project folder');
    // After an idle release the rule still applies.
    await waitFor('idle release', () => summaries.get(t.id)?.live === false, IDLE_MS + 30_000);
    const again = await client.call('threads.send', { threadId: t.id, text: 'Use the Bash tool to run exactly the same command again: touch first.txt . Then reply with only: done' });
    const againDone = await turnDone(t.id, again.turnId);
    assert.equal(againDone.outcome, 'completed', againDone.error);
    const againEvents = turnEvents(t.id, again.turnId);
    assert.ok(againEvents.some((e) => e.type === 'tool.call' && e.name === 'Bash'));
    assert.ok(!againEvents.some((e) => e.type === 'approval.requested'), 'not asked again after the resume');
    // Other commands still ask: the session didn't switch to accepting edits.
    const other = await client.call('threads.send', { threadId: t.id, text: 'Use the Bash tool to run exactly: mkdir zdir . Then reply with only: done' });
    const otherReq = await waitFor('second approval', () => turnEvents(t.id, other.turnId).find((e) => e.type === 'approval.requested'));
    await client.call('approvals.respond', { threadId: t.id, approvalId: otherReq.approvalId, decision: 'deny' });
    await turnDone(t.id, other.turnId);
    assert.equal(fs.existsSync(path.join(dir, 'zdir')), false);
    assert.equal(summaries.get(t.id)?.permissionMode, 'ask');
    assertProtocol(t.id);
    await client.call('threads.update', { threadId: t.id, archived: true });
  });

  test("edits to a file with no final newline and big command output keep to the protocol", async () => {
    fs.writeFileSync(path.join(cwd, 'nonl.txt'), 'alpha\nbeta');
    const t = await createThread({
      text: 'First use the Edit tool to change the word beta to gamma in nonl.txt. Then use the Bash tool to run exactly: seq 1 60000 . Then reply with only: done',
    });
    const done = await turnDone(t.id, t.turnId);
    assert.equal(done.outcome, 'completed', done.error);
    const diff = persisted(t.id).find((e) => e.type === 'edit.diff');
    assert.ok(diff, 'an edit.diff');
    assert.ok(diff.hunks.every((h: Ev) => h.lines.every((l: string) => !l.startsWith('\\'))));
    assert.ok(diff.hunks.some((h: Ev) => h.lines.includes('+gamma')));
    const big = persisted(t.id).find((e) => e.type === 'tool.result' && e.blobPath);
    assert.ok(big, 'the full output is kept');
    assert.equal(big.truncated, true);
    assert.ok(big.blobPath.startsWith(path.join(home, 'threads', t.id, 'blobs')));
    assert.ok(fs.statSync(big.blobPath).size > 300_000);
    assert.match(fs.readFileSync(big.blobPath, 'utf8'), /\n60000\n?$/);
    assertProtocol(t.id);
    await client.call('threads.update', { threadId: t.id, archived: true });
  });

  test("ask mode: a background subagent's approval is shown, not refused", async () => {
    const dir = path.join(root, 'sub');
    fs.mkdirSync(dir, { recursive: true });
    const t = await createThread({
      cwd: dir,
      permissionMode: 'ask',
      text: 'Use the Agent tool with run_in_background set to true to start a subagent whose task is: use the Bash tool to run exactly: sleep 3 && mkdir late-made . Do not wait for the subagent. Reply with only: LAUNCHED',
    });
    const req = await waitFor('subagent approval', () => persisted(t.id).find((e) => e.type === 'approval.requested' && /mkdir late-made/.test(e.title)), 120_000);
    assert.equal(req.itemId, undefined, "a subagent's tool has no tool.call in the thread");
    assert.ok(req.turnId, 'it belongs to a turn');
    await client.call('approvals.respond', { threadId: t.id, approvalId: req.approvalId, decision: 'allow' });
    await waitFor('folder', () => fs.existsSync(path.join(dir, 'late-made')), 60_000);
    // The turn holding the request ends once the CLI has reported back.
    await turnDone(t.id, req.turnId, 120_000);
    await waitFor('idle', () => summaries.get(t.id)?.status === 'idle', 60_000);
    assertProtocol(t.id);
    await client.call('threads.update', { threadId: t.id, archived: true });
  });

  test('runner killed mid-turn: next start stops the orphaned CLI and marks the thread stopped', async () => {
    const { turnId } = await client.call('threads.send', {
      threadId: main.id,
      text: 'Write the numbers from one to three hundred as English words, one per line, with nothing else.',
    });
    await waitFor('streaming', () => turnEvents(main.id, turnId).some((e) => e.type === 'assistant.text.delta'), 90_000);
    const children: { pid: number }[] = JSON.parse(fs.readFileSync(path.join(home, 'run', 'children.json'), 'utf8'));
    assert.equal(children.length, 1);
    const pid = children[0].pid;
    await stopRunner('SIGKILL');
    assert.doesNotThrow(() => process.kill(-pid, 0), 'the CLI outlives a SIGKILLed runner');
    events.delete(main.id);
    await startRunner();
    await waitFor('orphan stopped', () => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
    const t = (await client.call('threads.list', {})).threads.find((x: Ev) => x.id === main.id);
    assert.equal(t.status, 'stopped');
    assert.equal(t.live, false);
    const page = await client.call('threads.events', { threadId: main.id, limit: 5 });
    const done = page.events.find((e: Ev) => e.type === 'turn.completed' && e.turnId === turnId);
    assert.equal(done.outcome, 'interrupted');
    // And it resumes cleanly.
    await client.call('threads.subscribe', { threadId: main.id, afterSeq: page.lastSeq });
    const next = await client.call('threads.send', { threadId: main.id, text: 'Reply with just the word: back' });
    const nextDone = await turnDone(main.id, next.turnId);
    assert.equal(nextDone.outcome, 'completed', nextDone.error);
    assert.match(replyText(main.id, next.turnId), /back/i);
  });

  test('stopping the runner stops every CLI it started', async () => {
    const { turnId } = await client.call('threads.send', {
      threadId: main.id,
      text: 'Write the numbers from one to three hundred as English words, one per line, with nothing else.',
    });
    await waitFor('streaming', () => turnEvents(main.id, turnId).some((e) => e.type === 'assistant.text.delta'), 90_000);
    const children: { pid: number }[] = JSON.parse(fs.readFileSync(path.join(home, 'run', 'children.json'), 'utf8'));
    assert.ok(children.length >= 1, 'a CLI is live');
    await stopRunner('SIGTERM');
    for (const c of children) {
      assert.throws(() => process.kill(-c.pid, 0), `group ${c.pid} is gone`);
    }
    await startRunner();
    // The turn ended as stopped, not as a failure from its CLI being killed.
    const t = (await client.call('threads.list', {})).threads.find((x: Ev) => x.id === main.id);
    assert.equal(t.status, 'stopped');
    const page = await client.call('threads.events', { threadId: main.id, limit: 20 });
    const turn = page.events.filter((e: Ev) => e.turnId === turnId);
    assert.equal(turn.at(-1).type, 'turn.completed');
    assert.equal(turn.at(-1).outcome, 'interrupted');
    assert.ok(!turn.some((e: Ev) => e.type === 'error'));
    assert.deepEqual(checkSequence(page.events, page.firstSeq - 1), []);
  });
});
