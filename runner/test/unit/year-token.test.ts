// Year-long tokens (year-token.ts): a login's threadbear-token.json, made
// by the app's Year-long token…, goes to that login's CLI and nowhere else,
// shows on the account as when it was made, and counts a year for the
// sign-in warnings, since `auth status` calls any token signed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { SignInState, ENDING_SOON_MS } from '../../src/sign-in-state.ts';
import { TOKEN_FILE, TOKEN_LIFETIME_MS, readYearToken } from '../../src/year-token.ts';
import { cliEnv } from '../../src/adapters/claude/adapter.ts';
import { AccountRegistry, discoverAccounts } from '../../src/accounts.ts';
import type { Account } from '../../src/protocol.ts';
import { FakeAccounts, makeHarness, tick } from '../helpers/fakes.ts';
import { noFileWatches } from '../helpers/patience.ts';
import { onYearToken } from '../../src/year-token.ts';
import { withholdPath } from '../../src/withhold.ts';

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(90);
const MADE = '2026-11-17T07:00:00.000Z';

function folder(token?: object | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-year-'));
  if (token !== undefined) fs.writeFileSync(path.join(dir, TOKEN_FILE), typeof token === 'string' ? token : JSON.stringify(token), { mode: 0o600 });
  return dir;
}

test('reads a token file: the token and when it was made; anything else is no token', () => {
  assert.deepEqual(readYearToken(folder({ token: TOKEN, madeAt: MADE })), { token: TOKEN, madeAt: MADE });
  assert.deepEqual(readYearToken(folder({ token: TOKEN })), { token: TOKEN });
  assert.equal(readYearToken(folder()), undefined);
  assert.equal(readYearToken(folder('{not json')), undefined);
  assert.equal(readYearToken(folder({ token: 'sk-ant-api03-' + 'a'.repeat(90) })), undefined, 'an API key is not a setup-token');
  assert.equal(readYearToken(folder({ token: TOKEN + '\n; rm -rf ~' })), undefined);
  assert.equal(readYearToken(''), undefined);
});

test("a login's token goes to its own CLI only, never one from the runner's environment", () => {
  const mine = folder({ token: TOKEN, madeAt: MADE });
  const other = folder();
  const a = (id: string, configDir: string, provider: Account['provider'] = 'claude'): Account => ({ id, provider, title: id, configDir });
  const base = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-' + 'b'.repeat(90) };
  assert.equal(cliEnv(a('claude-1', mine), base).CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
  assert.equal(cliEnv(a('claude-3', other), base).CLAUDE_CODE_OAUTH_TOKEN, undefined, 'its Keychain sign-in, not the runner\'s token');
  assert.equal(cliEnv(a('codex-1', mine, 'codex'), base).CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('the account says it has a token and when it was made, never the token', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-year-accounts-'));
  const one = path.join(root, 'claude-1');
  fs.mkdirSync(one);
  fs.writeFileSync(path.join(one, TOKEN_FILE), JSON.stringify({ token: TOKEN, madeAt: MADE }));
  fs.mkdirSync(path.join(root, 'claude-2'));
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-year-main-'));
  const list = discoverAccounts({ claudeMainDir: main, claudeMainJson: path.join(main, 'none.json'), tokenStatsAccountsDir: root, userHome: os.tmpdir(), pathEnv: '' } as never);
  const byId = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.deepEqual(byId['claude-1'].yearToken, { madeAt: MADE });
  assert.equal(byId['claude-2'].yearToken, undefined);
  assert.ok(!JSON.stringify(list).includes(TOKEN));
});

// Mike, 18 Nov: the row took about 10 seconds to change after Year-long
// token… finished, the registry's rescan interval. The file landing in the
// login's folder is news at once.
test('a token made for a login is news straight away, not at the next rescan', async (t) => {
  if (await noFileWatches(t)) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-year-watch-'));
  const one = path.join(root, 'claude-1');
  fs.mkdirSync(one);
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-year-main-'));
  const registry = new AccountRegistry({ claudeMainDir: main, claudeMainJson: path.join(main, 'none.json'), tokenStatsAccountsDir: root, userHome: os.tmpdir(), pathEnv: '' } as never);
  let probe: fs.FSWatcher | undefined;
  try {
    assert.equal(registry.list().find((a) => a.id === 'claude-1')?.yearToken, undefined);
    probe = await watchIsLive(one);
    const heard = new Promise<Account[]>((resolve) => registry.onChange(resolve));
    // As the helper writes it: a temp file, then a rename onto the name.
    const tmp = path.join(one, `${TOKEN_FILE}.123`);
    fs.writeFileSync(tmp, JSON.stringify({ token: TOKEN, madeAt: MADE }), { mode: 0o600 });
    fs.renameSync(tmp, path.join(one, TOKEN_FILE));
    const list = await Promise.race([heard, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('not heard within 3 s')), 3000))]);
    assert.deepEqual(list.find((a) => a.id === 'claude-1')?.yearToken, { madeAt: MADE });
  } finally {
    probe?.close();
    registry.close();
  }
});

// On macOS a folder's fs.watch is libuv's one FSEvents stream, which starts
// on another thread and only reports what happens after it has, so a file
// written straight after fs.watch() returns can come too soon to be told:
// this test missed it 7 times in 48 on a loaded Tinker Desk (19 Nov). Each
// new watch restarts that shared stream with every watched folder in it, so
// once a watch made after the registry's hears a file of its own, the
// registry's is live too. That watch stays open until the test is done, as
// closing it restarts the stream again. (Linux's inotify is live at once.)
async function watchIsLive(dir: string): Promise<fs.FSWatcher> {
  const name = 'watch-probe';
  let seen = false;
  const w = fs.watch(dir, { persistent: false }, (_event, file) => {
    if (String(file) === name) seen = true;
  });
  const deadline = Date.now() + 10_000;
  for (let i = 0; !seen; i++) {
    if (Date.now() > deadline) throw new Error('the watch never heard its own probe file');
    fs.writeFileSync(path.join(dir, name), String(i));
    await new Promise((r) => setTimeout(r, 50));
  }
  return w;
}

test("a token login isn't asked the CLI; its end is a year from when it was made, and a new token takes a refusal back", async () => {
  const made = Date.parse(MADE);
  const clock = new FakeClock(made + TOKEN_LIFETIME_MS - ENDING_SOON_MS - 1000);
  const asked: string[] = [];
  const accounts: Account[] = [{ id: 'claude-1', provider: 'claude', title: 'one', configDir: '/x', yearToken: { madeAt: MADE } }];
  const state = new SignInState({ claudePath: 'c', accounts: () => accounts, env: () => ({}), clock, log: nullLogger, exec: async () => (asked.push('x'), JSON.stringify({ loggedIn: true })) });
  await state.checkAll();
  assert.deepEqual(asked, []);
  assert.deepEqual(state.view(accounts[0]), { loginEndsAt: new Date(made + TOKEN_LIFETIME_MS).toISOString() });
  // Refused: out for its hour, until a new token.
  state.noteRefused('claude-1');
  assert.equal(state.view(accounts[0]).signedOut, true);
  accounts[0] = { ...accounts[0], yearToken: { madeAt: new Date(clock.now()).toISOString() } };
  assert.equal(state.view(accounts[0]).signedOut, undefined, 'a new token');
  // Past its year: signed out.
  clock.advance(ENDING_SOON_MS + TOKEN_LIFETIME_MS);
  assert.equal(state.view(accounts[0]).signedOut, true);
  // A token file with no date: no end known, so no warning, and a refusal still holds.
  accounts[0] = { ...accounts[0], yearToken: {} };
  assert.deepEqual(state.view(accounts[0]), {});
  state.stop();
});

test('a new token lets go of the login\'s sessions, so the next turn starts on it, and takes a refusal back', async () => {
  const fake = new FakeAccounts();
  const notes: string[] = [];
  const h = makeHarness(undefined, {}, { accounts: fake, signIn: { noteRefused: () => {}, noteWorked: (id: string) => void notes.push(id), onChange: () => () => {} } });
  h.runner.sendAccounts();
  const { thread } = h.runner.create({ text: 'x', accountId: 'claude-3' });
  const first = h.adapter.last;
  first.init();
  first.result();
  await tick();
  assert.equal(first.ended, false);
  notes.length = 0;
  fake.base = fake.base.map((a) => (a.id === 'claude-3' ? { ...a, yearToken: { madeAt: MADE } } : a));
  h.runner.sendAccounts();
  assert.equal(first.ended || first.killed || first.endedHard, true, 'the idle session goes');
  assert.deepEqual(notes, ['claude-3']);
  h.runner.send(thread.id, 'again');
  await tick();
  assert.notEqual(h.adapter.last, first, 'a new session');
});

test('every token read is told to the scrubber, and its file counts as a secret file', () => {
  const got: string[] = [];
  const stop = onYearToken((t) => got.push(t));
  const other = 'sk-ant-oat01-' + 'c'.repeat(90);
  readYearToken(folder({ token: other, madeAt: MADE }));
  stop();
  assert.ok(got.includes(other));
  assert.ok(withholdPath('/Users/x/Token Stats/claude-1/threadbear-token.json'));
});
