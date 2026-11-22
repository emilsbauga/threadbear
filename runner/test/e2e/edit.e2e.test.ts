// End to end for editing an earlier message (docs/protocol/threads.md, "Editing a
// message") with the real Claude CLI: the agent writes files and is told a
// secret word, then the message that did it is edited. The files go back
// (the CLI's own checkpoints) and the agent no longer knows the word. A
// second edit, of the thread's first message, starts a fresh session.
// Temp runner, temp folder, the first Claude login that works (TB_E2E_ACCOUNT, src/test-login.ts), the cheapest model.
// Run with `node --test test/e2e/edit.e2e.test.ts`.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { RunnerClient } from '../../src/client.ts';
import { testLogin } from '../../src/test-login.ts';
import { checkSequence, isTransient } from '../helpers/protocol-check.ts';

const ACCOUNT = testLogin();
const MODEL = process.env.TB_E2E_MODEL ?? 'claude-haiku-5-5';
const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

type Ev = Record<string, any>;
let root: string;
let home: string;
let work: string;
let runner: ChildProcess;
let client: RunnerClient;
let output = '';
const events = new Map<string, Ev[]>();

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${dump()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function persisted(id: string): Ev[] {
  return (events.get(id) ?? []).filter((e) => !isTransient(e));
}

function dump(): string {
  return [...events.entries()]
    .map(([id, evs]) => `--- ${id}\n` + evs.filter((e) => !isTransient(e)).map((e) => `${e.seq} ${e.type} ${(e.title ?? e.text ?? e.name ?? '').toString().slice(0, 160)}`).join('\n'))
    .join('\n');
}

const turnDone = (id: string, turnId: string) => waitFor(`turn ${turnId}`, () => persisted(id).find((e) => e.type === 'turn.completed' && e.turnId === turnId));
const reply = (id: string, turnId: string) =>
  persisted(id)
    .filter((e) => e.type === 'assistant.text' && e.turnId === turnId)
    .map((e) => e.text)
    .join('\n');

describe('editing an earlier message end to end (real Claude CLI)', { concurrency: false }, () => {
  before(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-edit-e2e-')));
    home = path.join(root, 'home');
    work = path.join(root, 'work');
    fs.mkdirSync(work, { recursive: true });
    runner = spawn(process.execPath, ['src/main.ts'], {
      cwd: RUNNER_DIR,
      env: { ...process.env, THREADBEAR_HOME: home, THREADBEAR_PORT: '0', THREADBEAR_LOG: path.join(root, 'runner.log'), THREADBEAR_DEBUG: '1', THREADBEAR_CLI_UPDATES: 'off', THREADBEAR_TOKEN_TALLY: 'off' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await new Promise<number>((resolve, reject) => {
      runner.stdout!.on('data', (d) => {
        output += d;
        const m = /listening on (\d+)/.exec(output);
        if (m) resolve(Number(m[1]));
      });
      runner.stderr!.on('data', (d) => (output += d));
      runner.once('exit', (code) => reject(new Error(`runner exited ${code}:\n${output}`)));
    });
    const token = fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();
    client = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, token);
    client.onNotification((method, params) => {
      if (method !== 'thread.event') return;
      const list = events.get(params.threadId) ?? [];
      list.push(params.event);
      events.set(params.threadId, list);
    });
    await client.call('hello', { client: 'e2e-edit', version: '1' });
  });

  after(async () => {
    client?.close();
    if (runner && runner.exitCode === null) {
      const exited = new Promise((r) => runner.once('exit', r));
      runner.kill('SIGTERM');
      await exited;
    }
    if (process.env.TB_KEEP) console.log(`kept ${root}`);
    else fs.rmSync(root, { recursive: true, force: true });
  });

  test('the agent forgets everything from the edited message on, and its file changes are put back', async () => {
    const a = path.join(work, 'a.txt');
    const b = path.join(work, 'b.txt');
    const r = await client.call('threads.create', {
      accountId: ACCOUNT,
      model: MODEL,
      cwd: work,
      text: 'Use the Write tool to create a.txt containing exactly: one. Then reply with just: ok',
    });
    const id = r.thread.id;
    await client.call('threads.subscribe', { threadId: id, afterSeq: 0 }).then((s: Ev) => {
      const live = events.get(id) ?? [];
      const seen = new Set(s.events.map((e: Ev) => e.seq));
      events.set(id, [...s.events, ...live.filter((e) => isTransient(e) || !seen.has(e.seq))]);
    });
    assert.equal((await turnDone(id, r.turnId)).outcome, 'completed');
    assert.equal(fs.readFileSync(a, 'utf8').trim(), 'one');

    const second = (
      await client.call('threads.send', {
        threadId: id,
        text: 'My secret word is PELICAN. Use the Edit tool to change a.txt so it says two, and the Write tool to create b.txt containing: bee. Then reply with just: done',
      })
    ).turnId;
    assert.equal((await turnDone(id, second)).outcome, 'completed');
    assert.equal(fs.readFileSync(a, 'utf8').trim(), 'two');
    assert.ok(fs.existsSync(b));

    const seq = persisted(id).find((e) => e.type === 'user.message' && e.turnId === second)!.seq;
    const edit = await client.call('threads.edit', {
      threadId: id,
      seq,
      text: 'What secret word did I tell you, if any? Answer with one word, or NONE. Do not use any tools.',
    });
    // The CLI's checkpoints put both files back.
    assert.equal(edit.rewound.files.how, 'checkpoint', JSON.stringify(edit.rewound));
    assert.deepEqual([...edit.rewound.files.undone].sort(), [a, b].sort());
    assert.equal(fs.readFileSync(a, 'utf8').trim(), 'one');
    assert.equal(fs.existsSync(b), false);
    const done = await turnDone(id, edit.turnId);
    assert.equal(done.outcome, 'completed', done.error);
    assert.match(reply(id, edit.turnId), /NONE/i);
    assert.doesNotMatch(reply(id, edit.turnId), /PELICAN/i);

    // A plain message after it carries on from the edited branch: the
    // question it was asked, not the cut one.
    const third = (await client.call('threads.send', { threadId: id, text: 'Quote the last question I asked you, word for word. Do not use any tools.' })).turnId;
    assert.equal((await turnDone(id, third)).outcome, 'completed');
    assert.match(reply(id, third), /secret word/i);
    assert.doesNotMatch(reply(id, third), /PELICAN|b\.txt/i);

    // Editing the thread's first message starts a fresh session, and the
    // file it made goes too.
    const firstSeq = persisted(id).find((e) => e.type === 'user.message')!.seq;
    const fresh = await client.call('threads.edit', { threadId: id, seq: firstSeq, text: 'Reply with just: fresh start' });
    assert.equal(fresh.rewound.files.how, 'checkpoint');
    assert.equal(fs.existsSync(a), false);
    assert.equal((await turnDone(id, fresh.turnId)).outcome, 'completed');
    assert.match(reply(id, fresh.turnId), /fresh start/i);
    assert.deepEqual(checkSequence(persisted(id)), []);
  });
});
