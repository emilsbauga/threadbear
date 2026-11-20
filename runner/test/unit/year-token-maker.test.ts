// Year-long token… from another Mac (year-token-maker.ts): the real helper in
// a real pty, against a stand-in for `claude setup-token` that prints its page
// the way 2.1.3xx does (an OSC 8 link, spaces drawn as cursor moves) and a
// token once it's given the right code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { YearTokenMaker, urlState } from '../../src/year-token-maker.ts';
import type { Account } from '../../src/protocol.ts';

// Making a token runs setup-token in a pty (python3's pty module), which a
// Windows runner doesn't do: it says so instead (year-token-maker.ts).
const NO_PTY = process.platform === 'win32' ? 'setup-token runs in a pty, which Windows has none of' : false;

const STATE = 'Y1Miuwn1u5kKwrI7dwuczDg09inC94FeD8_utBRyPZ0';
const PAGE = `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=${STATE}`;
const LOCAL = `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback&state=${STATE}`;
const TOKEN = `sk-ant-oat01-${'Ab3_-'.repeat(20)}`;
const CODE = `6rrspdXVUDGfsF4pr2VwiXJRNecXr1rliqAIdoQm#${STATE}`;

function fakeClaude(dir: string, opts: { takes?: string; split?: boolean } = {}): string {
  const file = path.join(dir, 'claude');
  // The localhost page first (what it opens in a browser), then the one to
  // copy, inside an OSC 8 link and again as text, words spaced by cursor moves.
  fs.writeFileSync(path.join(dir, 'page.txt'), `Opening\x1b[1Cbrowser\n${LOCAL}\nBrowser\x1b[1Cdidn't\x1b[1Copen?\n\x1b]8;id=x;${PAGE}\x1b\\${PAGE.slice(0, 60)}\x1b]8;;\x1b\\\nPaste code here if prompted > `);
  // Split, the token comes in two reads, the first long enough to look whole.
  const cut = opts.split ? 13 + 50 : TOKEN.length;
  fs.writeFileSync(path.join(dir, 'token.txt'), `\nYour token:\n\n${TOKEN.slice(0, cut)}`);
  fs.writeFileSync(path.join(dir, 'token2.txt'), `${TOKEN.slice(cut)}\n\nStore it safely.\n`);
  fs.writeFileSync(path.join(dir, 'want.txt'), opts.takes ?? CODE);
  fs.writeFileSync(
    file,
    `#!/bin/sh
[ "$1" = setup-token ] || exit 3
d='${dir}'
cat "$d/page.txt"
IFS= read -r code
code=$(printf '%s' "$code" | tr -d '\\r')
if [ "$code" = "$(cat "$d/want.txt")" ]; then
  cat "$d/token.txt"
  sleep 1
  cat "$d/token2.txt"
  sleep 5
else
  echo 'OAuth error: Invalid code'
  sleep 60
fi
`,
    { mode: 0o755 },
  );
  return file;
}

function setUp(opts: { takes?: string; answerWaitMs?: number; split?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-yeartoken-'));
  const login = path.join(dir, 'claude-1');
  fs.mkdirSync(login);
  const logs: string[] = [];
  const maker = new YearTokenMaker({
    claudePath: fakeClaude(dir, opts),
    env: () => ({ PATH: process.env.PATH, HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-old' }),
    log: { info: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`), warn: (m, d) => logs.push(`${m} ${JSON.stringify(d)}`) },
    answerWaitMs: opts.answerWaitMs ?? 4000,
    codeWaitSecs: 3,
  });
  const account = { id: 'claude-1', provider: 'claude', title: 'one', configDir: login } as Account;
  return { dir, login, maker, account, logs, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function until<T>(f: () => Promise<T>, ok: (t: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const t = await f();
    if (ok(t) || Date.now() > end) return t;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test("a code from the page makes the token in the login's folder, and no answer or log has it", { skip: NO_PTY }, async () => {
  const s = setUp();
  try {
    const first = await until(() => s.maker.step(s.account, {}), (a) => a.state !== 'starting');
    assert.deepEqual(first, { state: 'waiting', url: PAGE }, 'the page that shows a code, not the localhost one');
    assert.equal((await s.maker.step(s.account, {})).url, PAGE, 'a second start joins the first');
    await assert.rejects(s.maker.step(s.account, { code: `abcdefghij#${'x'.repeat(43)}` }), /another sign-in page/);
    await assert.rejects(s.maker.step(s.account, { code: `${CODE}\n\u001b[2~` }), /isn't a code/);
    await assert.rejects(s.maker.step(s.account, { code: 'no hash here at all' }), /isn't a code/);
    const answers = [await s.maker.step(s.account, { code: CODE })];
    answers.push(await until(() => s.maker.step(s.account, { check: true }), (a) => a.state === 'done' || a.state === 'failed'));
    const last = answers.at(-1)!;
    assert.equal(last.state, 'done', JSON.stringify(last));
    assert.match(last.madeAt ?? '', /^\d{4}-\d\d-\d\dT/);
    const file = path.join(s.login, 'threadbear-token.json');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, TOKEN);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify([first, ...answers, s.logs]).includes('sk-ant-oat01-'), 'the token stays in the file');
  } finally {
    s.done();
  }
});

test("a code setup-token doesn't take fails rather than waiting out the session", { skip: NO_PTY }, async () => {
  const s = setUp({ takes: 'something-else#nope', answerWaitMs: 500 });
  try {
    await until(() => s.maker.step(s.account, {}), (a) => a.state === 'waiting');
    assert.equal((await s.maker.step(s.account, { code: CODE })).state, 'checking');
    await assert.rejects(s.maker.step(s.account, { code: CODE }), /already being checked/);
    const end = await until(() => s.maker.step(s.account, { check: true }), (a) => a.state !== 'checking', 15_000);
    assert.equal(end.state, 'failed');
    assert.match(end.message ?? '', /didn't take that code/);
    assert.ok(!fs.existsSync(path.join(s.login, 'threadbear-token.json')));
  } finally {
    s.done();
  }
});

test('cancel stops it, and nothing but a Claude login with a folder is taken', async () => {
  const s = setUp();
  try {
    await until(() => s.maker.step(s.account, {}), (a) => a.state === 'waiting');
    assert.deepEqual(await s.maker.step(s.account, { cancel: true }), { state: 'idle' });
    assert.deepEqual(await s.maker.step(s.account, { check: true }), { state: 'idle' });
    await assert.rejects(s.maker.step(s.account, { code: CODE }), /finished/);
    await assert.rejects(s.maker.step({ ...s.account, provider: 'codex' } as Account, {}), /only for Claude/);
    await assert.rejects(s.maker.step({ ...s.account, configDir: '' }, {}), /doesn't know where/);
  } finally {
    s.done();
  }
});

test("a pasted code's state is the page's own", () => {
  assert.equal(urlState(PAGE), STATE);
  assert.equal(urlState('https://claude.com/x?state=short'), undefined);
  assert.equal(urlState('not a url'), undefined);
});

test('a token that comes in two reads is saved whole, not cut at the first', { skip: NO_PTY }, async () => {
  const s = setUp({ split: true });
  try {
    await until(() => s.maker.step(s.account, {}), (a) => a.state === 'waiting');
    await s.maker.step(s.account, { code: CODE });
    const end = await until(() => s.maker.step(s.account, { check: true }), (a) => a.state === 'done' || a.state === 'failed');
    assert.equal(end.state, 'done');
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.login, 'threadbear-token.json'), 'utf8')).token, TOKEN);
  } finally {
    s.done();
  }
});
