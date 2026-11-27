// Use this Mac's Claude logins on another runner (login-share.ts,
// docs/protocol/settings.md "This Mac's logins on another runner"). On 26 Nov
// 2026 Bruce stalled on its one login while the M5 had three with room; Mike
// copied two tokens over by hand, and this does it from a switch.
//
// The tokens here are made up, and no assertion compares one with equal():
// a failing one would print it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecretStore, sealBytes } from '../../src/secrets.ts';
import { FakeClock } from '../../src/clock.ts';
import { applyShared, cleanAnswer, digestOf, gatherLogins, LoginSharer, MARKER_FILE, mergedList, openShared, sealInfo, sealLogins, shareable, sharedFolders, trimProfile, type ShareAnswer, type SealedLogin, type ShareLayout } from '../../src/login-share.ts';
import type { Account, Pool } from '../../src/protocol.ts';

const fakeToken = () => `sk-ant-oat01-${crypto.randomBytes(48).toString('base64url')}`;
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;

function tmp(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `login-share-${name}-`)));
}

function keys() {
  const store = new SecretStore(tmp('secrets'));
  return { publicKey: store.publicKey(), open: (b: Buffer, info: string) => store.openBytes(b, info) };
}

const has = (text: string, token: string) => text.includes(token) || text.includes(token.slice('sk-ant-oat01-'.length));
const tokenIn = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'threadbear-token.json'), 'utf8')).token as string;

test('a sealed login opens only on the runner and email it was sealed for, and its errors never quote it', () => {
  const bruce = keys();
  const other = keys();
  const token = fakeToken();
  const login = { email: 'mike@example.com', token, madeAt: '2026-11-20T00:00:00.000Z', oauthAccount: { emailAddress: 'mike@example.com', organizationType: 'claude_max' } };
  const [sealed] = sealLogins('bruce1', bruce.publicKey, [login]) as [SealedLogin];
  assert.equal(has(sealed.box, token), false, 'the box is ciphertext');
  assert.equal(has(Buffer.from(sealed.box, 'base64').toString('latin1'), token), false);
  const opened = openShared(bruce.open, 'bruce1', sealed);
  assert.ok(opened.token === token, 'it opens to the same token');
  assert.equal(opened.madeAt, login.madeAt);
  assert.equal(opened.oauthAccount.organizationType, 'claude_max');
  const errors: string[] = [];
  const tries: [(b: Buffer, i: string) => Buffer, string, SealedLogin][] = [
    [other.open, 'bruce1', sealed], // another runner's key
    [bruce.open, 'cloud1', sealed], // sealed for another runner
    [bruce.open, 'bruce1', { email: 'someone@example.com', box: sealed.box }], // under another email
    [bruce.open, 'bruce1', { email: sealed.email, box: Buffer.from(Buffer.from(sealed.box, 'base64').map((b, i) => (i === 50 ? b ^ 1 : b))).toString('base64') }], // tampered
  ];
  for (const [open, self, entry] of tries) {
    assert.throws(
      () => openShared(open, self, entry),
      (e: Error) => (errors.push(e.message), /couldn't be opened here/.test(e.message)),
    );
  }
  // A box that opens but doesn't hold a login: its text is never in the error.
  const junk = sealBytes(bruce.publicKey, Buffer.from(`{"token": "${token}", oops`), sealInfo('bruce1', 'mike@example.com')).toString('base64');
  assert.throws(() => openShared(bruce.open, 'bruce1', { email: 'mike@example.com', box: junk }), (e: Error) => (errors.push(e.message), true));
  // Nor a profile naming another account than the box's email.
  const [wrong] = sealLogins('bruce1', bruce.publicKey, [{ ...login, oauthAccount: { emailAddress: 'else@example.com' } }]) as [SealedLogin];
  assert.throws(() => openShared(bruce.open, 'bruce1', wrong), (e: Error) => (errors.push(e.message), true));
  for (const m of errors) assert.equal(has(m, token), false, 'no error quotes the token');
});

test('only Claude logins with a token and email, no note, a live plan and not only in work pools are shared', () => {
  const a = (id: string, extra: Partial<Account> = {}): Account => ({ id, provider: 'claude', title: id, configDir: `/x/${id}`, email: `${id}@example.com`, yearToken: {}, ...extra });
  const accounts = [a('claude-1'), a('claude-2', { note: 'Convex work only' }), a('claude-3'), a('claude-4'), a('claude-5', { yearToken: undefined }), a('claude-6', { planEnded: true }), a('claude-7', { email: undefined }), a('claude-8'), { ...a('codex-1'), provider: 'codex' as const }, a('claude-9', { email: 'CLAUDE-1@example.com' })];
  const pools: Pool[] = [
    { id: 'claude', title: 'Claude', accountIds: ['claude-1', 'claude-3'] },
    { id: 'convex', title: 'Convex', accountIds: ['claude-2', 'claude-8'], folders: ['~/dev/convex'] },
  ];
  assert.deepEqual(
    shareable(accounts, pools).map((x) => x.id),
    ['claude-1', 'claude-3', 'claude-4'],
  );
});

function layoutFor(): ShareLayout & { root: string } {
  const root = tmp('runner');
  const main = path.join(root, '.claude');
  fs.mkdirSync(path.join(main, 'skills', 'delegate'), { recursive: true });
  fs.writeFileSync(path.join(main, 'CLAUDE.md'), '# rules\n');
  fs.writeFileSync(path.join(main, 'settings.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { x: { url: 'https://example.test' } }, oauthAccount: { emailAddress: 'bruce-own@example.com' }, primaryApiKey: 'not-to-copy' }));
  return { root, accountsDir: path.join(root, 'data', 'accounts'), tokenStatsAccountsDir: path.join(root, 'ts'), claudeMainDir: main, claudeMainJson: path.join(root, '.claude.json'), now: () => new Date('2026-11-26T05:00:00.000Z') };
}

const claude = (id: string, dir: string, email: string): Account => ({ id, provider: 'claude', title: email, configDir: dir, email });

test("a shared login gets a folder of its own, renews in place, and only ones it made or was copied are removed", async () => {
  const L = layoutFor();
  fs.mkdirSync(path.join(L.tokenStatsAccountsDir!, 'claude-1'), { recursive: true });
  // Two made by hand: one signed in here, one with this Mac's token copied in.
  const handSigned = path.join(L.accountsDir, 'claude-2');
  const handCopied = path.join(L.accountsDir, 'claude-3');
  fs.mkdirSync(handSigned, { recursive: true });
  fs.mkdirSync(handCopied, { recursive: true });
  const ownToken = fakeToken();
  const copied = fakeToken();
  fs.writeFileSync(path.join(handSigned, 'threadbear-token.json'), JSON.stringify({ token: ownToken }));
  fs.writeFileSync(path.join(handCopied, 'threadbear-token.json'), JSON.stringify({ token: copied }));
  const existing = [claude('claude-2', handSigned, 'signed@example.com'), claude('claude-3', handCopied, 'copied@example.com')];
  const fresh = { email: 'new@example.com', token: fakeToken(), madeAt: '2026-11-01T00:00:00.000Z', oauthAccount: { emailAddress: 'new@example.com', organizationType: 'claude_max' } };
  const wanted = [fresh, { email: 'signed@example.com', token: fakeToken(), oauthAccount: { emailAddress: 'signed@example.com' } }, { email: 'copied@example.com', token: copied, oauthAccount: { emailAddress: 'copied@example.com' } }];

  const first = await applyShared(L, wanted, [], existing);
  assert.deepEqual(first.logins.map((l) => [l.email, l.state, l.accountId]), [
    ['new@example.com', 'added', 'claude-4'],
    ['signed@example.com', 'here', 'claude-2'],
    ['copied@example.com', 'adopted', 'claude-3'],
  ]);
  assert.deepEqual(first.removed, []);
  const made = path.join(L.accountsDir, 'claude-4');
  assert.ok(tokenIn(made) === fresh.token, 'the token is in its folder');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(made, 'threadbear-token.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(made).mode & 0o777, 0o700);
  }
  const json = JSON.parse(fs.readFileSync(path.join(made, '.claude.json'), 'utf8'));
  assert.equal(json.oauthAccount.emailAddress, 'new@example.com', "the runner reads the login's email from here");
  assert.equal(json.mcpServers.x.url, 'https://example.test', "the rest is the runner's own claude-main's");
  assert.equal(json.primaryApiKey, undefined);
  for (const name of ['CLAUDE.md', 'settings.json', 'skills']) assert.equal(fs.readlinkSync(path.join(made, name)), path.join(L.claudeMainDir, name));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(made, MARKER_FILE), 'utf8')), { email: 'new@example.com', sharedAt: '2026-11-26T05:00:00.000Z' });
  assert.ok(tokenIn(handSigned) === ownToken, 'a login signed in here keeps its own token');
  assert.equal(fs.existsSync(path.join(handSigned, MARKER_FILE)), false);
  assert.equal(fs.readdirSync(L.accountsDir).filter((n) => n.startsWith('.')).length, 0, 'no temp folder left');

  // Again, the same: nothing changes. Then renewed: rewritten in place.
  const all = [...existing, claude('claude-4', made, 'new@example.com')];
  const again = await applyShared(L, wanted, [], all);
  // The copied folder had no profile of this login's: it gets one, once.
  assert.deepEqual(again.logins.map((l) => l.state), ['same', 'here', 'updated']);
  const renewed = { ...fresh, token: fakeToken(), madeAt: '2026-11-25T00:00:00.000Z' };
  const third = await applyShared(L, [renewed, ...wanted.slice(1)], [], all);
  assert.deepEqual(third.logins.map((l) => l.state), ['updated', 'here', 'same']);
  assert.ok(tokenIn(made) === renewed.token);

  // A box that didn't open keeps its folder; a login no longer sent goes.
  const fourth = await applyShared(L, [], [{ email: 'new@example.com', message: 'x' }], all);
  assert.deepEqual(fourth.removed, [{ email: 'copied@example.com', accountId: 'claude-3' }]);
  assert.ok(fs.existsSync(made));
  // Off: everything it made or took on goes, and nothing signed in here.
  const off = await applyShared(L, [], [], all);
  assert.deepEqual(off.removed, [{ email: 'new@example.com', accountId: 'claude-4' }]);
  assert.deepEqual(fs.readdirSync(L.accountsDir).sort(), ['.removed', 'claude-2']);
  assert.ok(tokenIn(handSigned) === ownToken);
  const aside = fs.readdirSync(path.join(L.accountsDir, '.removed'));
  assert.equal(aside.length, 2);
  for (const d of aside) assert.equal(fs.existsSync(path.join(L.accountsDir, '.removed', d, 'threadbear-token.json')), false, 'a removed login keeps no token');
  assert.equal(sharedFolders(L.accountsDir).size, 0);
});

test('a link that is a file of the login\'s own is left as it is', async () => {
  const L = layoutFor();
  const login = { email: 'a@example.com', token: fakeToken(), oauthAccount: {} };
  const r = await applyShared(L, [login], [], []);
  const dir = path.join(L.accountsDir, r.logins[0]!.accountId!);
  fs.unlinkSync(path.join(dir, 'CLAUDE.md'));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'mine');
  await applyShared(L, [login], [], [claude(r.logins[0]!.accountId!, dir, 'a@example.com')]);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), 'mine');
});

function mainMac() {
  const root = tmp('mac');
  const dir = (id: string) => path.join(root, id);
  const write = (id: string, email: string, token: string, madeAt: string) => {
    fs.mkdirSync(dir(id), { recursive: true });
    fs.writeFileSync(path.join(dir(id), 'threadbear-token.json'), JSON.stringify({ token, madeAt }));
    fs.writeFileSync(path.join(dir(id), '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, accountUuid: id } }));
  };
  const tokens: Record<string, string> = { 'claude-1': fakeToken(), 'claude-3': fakeToken() };
  write('claude-1', 'one@example.com', tokens['claude-1']!, '2026-11-01T00:00:00.000Z');
  write('claude-3', 'three@example.com', tokens['claude-3']!, '2026-11-02T00:00:00.000Z');
  const accounts: Account[] = [
    { id: 'claude-1', provider: 'claude', title: 'one', configDir: dir('claude-1'), email: 'one@example.com', yearToken: {} },
    { id: 'claude-2', provider: 'claude', title: 'work', configDir: dir('claude-2'), email: 'work@example.com', yearToken: {}, note: 'Convex work only' },
    { id: 'claude-3', provider: 'claude', title: 'three', configDir: dir('claude-3'), email: 'three@example.com', yearToken: {} },
  ];
  return { root, dir, write, tokens, accounts };
}

test('the main Mac sends sealed logins when switched on, again when a token is renewed, and takes them back when off', async () => {
  const mac = mainMac();
  const bruce = keys();
  const bruceLayout = layoutFor();
  const sent: { runnerId: string; logins: SealedLogin[] }[] = [];
  const lists: [string, string[], string[]][] = [];
  let online = true;
  const clock = new FakeClock();
  const sharer = new LoginSharer({
    file: path.join(mac.root, 'login-share.json'),
    accounts: () => mac.accounts,
    pools: () => [],
    claudeMainJson: path.join(mac.root, 'none.json'),
    blocked: () => undefined,
    runner: (id) => (id === 'bruce1' ? { name: 'bruce', online } : id === 'self' ? { name: 'M5', online: true, self: true } : id === 'box1' ? { name: 'box', online: true, box: true } : undefined),
    sealKey: async () => bruce.publicKey,
    share: async (runnerId, logins): Promise<ShareAnswer> => {
      if (!online) throw new Error("bruce is offline, so that can't reach it now.");
      sent.push({ runnerId, logins });
      const opened = logins.map((l) => openShared(bruce.open, runnerId, l));
      const existing = [...sharedFolders(bruceLayout.accountsDir)].map(([email, f]) => claude(f.id, f.dir, email));
      return applyShared(bruceLayout, opened, [], existing);
    },
    setShared: async (runnerId, add, remove) => void lists.push([runnerId, add, remove]),
    clock,
    log: quiet,
  });
  await assert.rejects(sharer.set('self', true), /another of your runners/);
  await assert.rejects(sharer.set('box1', true), /virtual runner/);
  await assert.rejects(sharer.set('nope', true), /another of your runners/);

  const on = await sharer.set('bruce1', true);
  assert.equal(on.state, 'ok');
  assert.deepEqual(on.logins!.map((l) => [l.email, l.state]), [['one@example.com', 'added'], ['three@example.com', 'added']]);
  assert.deepEqual(sent[0]!.logins.map((l) => l.email), ['one@example.com', 'three@example.com'], 'the noted work login stays here');
  const wire = JSON.stringify(sent);
  for (const t of Object.values(mac.tokens)) assert.equal(has(wire, t), false, 'only ciphertext goes');
  assert.deepEqual(lists, [['bruce1', ['one@example.com', 'three@example.com'], []]]);
  const saved = fs.readFileSync(path.join(mac.root, 'login-share.json'), 'utf8');
  for (const t of Object.values(mac.tokens)) assert.equal(has(saved, t), false, 'the switches file holds no token');

  // Nothing changed: nothing goes.
  await sharer.check();
  await sharer.idle();
  assert.equal(sent.length, 1);

  // A renewed token goes again by itself, and lands in place.
  const renewed = fakeToken();
  mac.write('claude-3', 'three@example.com', renewed, '2026-11-26T00:00:00.000Z');
  await sharer.check();
  await sharer.idle();
  assert.equal(sent.length, 2);
  assert.deepEqual(sharer.list()[0]!.logins!.map((l) => l.state), ['same', 'updated']);
  const three = sharedFolders(bruceLayout.accountsDir).get('three@example.com')!;
  assert.ok(tokenIn(three.dir) === renewed);

  // Offline: waiting, then the timer sends once it's back.
  online = false;
  mac.write('claude-1', 'one@example.com', fakeToken(), '2026-11-27T00:00:00.000Z');
  await sharer.check();
  await sharer.idle();
  assert.equal(sent.length, 2);
  online = true;
  sharer.start();
  clock.advance(10 * 60_000);
  await sharer.idle();
  assert.equal(sent.length, 3);
  assert.equal(sharer.list()[0]!.state, 'ok');

  // Off: an empty share, its logins gone there and off its list.
  const off = await sharer.set('bruce1', false);
  assert.equal(off.state, 'off');
  assert.deepEqual(sent.at(-1)!.logins, []);
  assert.deepEqual(lists.at(-1), ['bruce1', [], ['one@example.com', 'three@example.com']]);
  assert.equal(sharedFolders(bruceLayout.accountsDir).size, 0);
  assert.deepEqual(sharer.list(), []);
  sharer.stop();
});

test("a runner that isn't the owner shares nothing", async () => {
  const mac = mainMac();
  const sharer = new LoginSharer({
    file: path.join(mac.root, 'login-share.json'),
    accounts: () => mac.accounts,
    pools: () => [],
    claudeMainJson: '',
    blocked: () => "Only the main Mac's runner shares its logins.",
    runner: () => ({ name: 'x', online: true }),
    sealKey: async () => assert.fail('no key asked'),
    share: async () => assert.fail('nothing sent'),
    clock: new FakeClock(),
    log: quiet,
  });
  await assert.rejects(sharer.set('bruce1', true), /Only the main Mac/);
  assert.deepEqual(sharer.list(), []);
});

test('gathered logins carry their profile, and the digest changes with a token but never holds one', () => {
  const mac = mainMac();
  const logins = gatherLogins(shareable(mac.accounts, []), '');
  assert.deepEqual(logins.map((l) => [l.email, l.oauthAccount.accountUuid]), [['one@example.com', 'claude-1'], ['three@example.com', 'claude-3']]);
  const d1 = digestOf(logins);
  mac.write('claude-1', 'one@example.com', fakeToken(), '2026-11-01T00:00:00.000Z');
  const d2 = digestOf(gatherLogins(shareable(mac.accounts, []), ''));
  assert.notEqual(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
});

test("the shared list gets the logins that landed and loses the removed, the rest as it was", () => {
  const cur = [{ provider: 'claude', email: 'hand@example.com' }, { provider: 'codex', email: 'one@example.com' }, { provider: 'claude', email: 'old@example.com' }];
  assert.deepEqual(mergedList(cur, ['one@example.com', 'Hand@example.com'], ['old@example.com']), [{ provider: 'claude', email: 'hand@example.com' }, { provider: 'codex', email: 'one@example.com' }, { provider: 'claude', email: 'one@example.com' }]);
  assert.equal(mergedList(cur, ['hand@example.com'], []), undefined);
});

// Codex's review, 26 Nov: what a renewal, an adoption or a removal may touch.
test('a linked login folder is never taken on, renewed or removed, and a half-made one is cleared', async () => {
  const L = layoutFor();
  const elsewhere = path.join(L.root, 'ts-claude-3');
  fs.mkdirSync(elsewhere, { recursive: true });
  const token = fakeToken();
  fs.writeFileSync(path.join(elsewhere, 'threadbear-token.json'), JSON.stringify({ token }));
  fs.mkdirSync(L.accountsDir, { recursive: true });
  fs.symlinkSync(elsewhere, path.join(L.accountsDir, 'claude-3'));
  // Even one carrying a marker, as if made here.
  fs.writeFileSync(path.join(elsewhere, MARKER_FILE), JSON.stringify({ email: 'copied@example.com' }));
  const half = path.join(L.accountsDir, '.claude-9.partial-1-abcd');
  fs.mkdirSync(half);
  fs.writeFileSync(path.join(half, 'threadbear-token.json'), JSON.stringify({ token: fakeToken() }));
  const made: string[] = [];
  const existing = [claude('claude-3', path.join(L.accountsDir, 'claude-3'), 'copied@example.com')];
  const r = await applyShared({ ...L, makePrivate: async (d) => void made.push(path.basename(d)) }, [{ email: 'copied@example.com', token, oauthAccount: {} }], [], existing);
  assert.deepEqual(r.logins.map((l) => l.state), ['here']);
  assert.equal(fs.existsSync(half), false, 'a half-made folder goes, token and all');
  const off = await applyShared(L, [], [], existing);
  assert.deepEqual(off.removed, []);
  assert.ok(tokenIn(elsewhere) === token, 'the folder it leads to keeps its token');
  assert.ok(fs.lstatSync(path.join(L.accountsDir, 'claude-3')).isSymbolicLink());
  assert.deepEqual(made, []);
});

test('a folder is made private when it is made or taken on, not again at a renewal (its links would fail the check)', async () => {
  const L = layoutFor();
  const made: string[] = [];
  const layout = { ...L, makePrivate: async (d: string) => void made.push(path.basename(d)) };
  const copied = path.join(L.accountsDir, 'claude-3');
  fs.mkdirSync(copied, { recursive: true });
  const token = fakeToken();
  fs.writeFileSync(path.join(copied, 'threadbear-token.json'), JSON.stringify({ token }));
  const existing = [claude('claude-3', copied, 'copied@example.com')];
  await applyShared(layout, [{ email: 'copied@example.com', token, madeAt: '2026-11-01T00:00:00.000Z', oauthAccount: {} }], [], existing);
  assert.deepEqual(made, ['claude-3']);
  await applyShared(layout, [{ email: 'copied@example.com', token: fakeToken(), oauthAccount: {} }], [], existing);
  assert.deepEqual(made, ['claude-3']);
  const r = await applyShared(layout, [{ email: 'new@example.com', token: fakeToken(), oauthAccount: {} }], [], existing);
  assert.equal(made.length, 2);
  assert.match(made[1]!, /^\.claude-\d+\.partial-/, 'a new one before its token goes in');
  assert.equal(r.logins.find((l) => l.email === 'new@example.com')!.state, 'added');
  // Refused (Windows, a folder holding links): left as it is, and says why.
  const other = path.join(L.accountsDir, 'claude-8');
  fs.mkdirSync(other);
  const t2 = fakeToken();
  fs.writeFileSync(path.join(other, 'threadbear-token.json'), JSON.stringify({ token: t2 }));
  const refused = await applyShared({ ...L, makePrivate: async () => 'no access' }, [{ email: 'eight@example.com', token: t2, oauthAccount: {} }], [], [claude('claude-8', other, 'eight@example.com')]);
  assert.equal(refused.logins[0]!.state, 'here');
  assert.match(refused.logins[0]!.message!, /Left as it is: .*private: no access/);
  assert.equal(fs.existsSync(path.join(other, MARKER_FILE)), false);
});

test("a switch that can't be saved isn't flipped, and emails a list update missed come off it later", async () => {
  const mac = mainMac();
  const lists: [string[], string[]][] = [];
  let listFails = false;
  let answer: ShareAnswer = { logins: [{ email: 'one@example.com', state: 'added', accountId: 'claude-5' }], removed: [] };
  const clock = new FakeClock();
  const file = path.join(mac.root, 'login-share.json');
  const sharer = new LoginSharer({
    file,
    accounts: () => mac.accounts,
    pools: () => [],
    claudeMainJson: '',
    blocked: () => undefined,
    runner: () => ({ name: 'bruce', online: true }),
    sealKey: async () => keys().publicKey,
    share: async () => answer,
    setShared: async (_id, add, remove) => {
      if (listFails) throw new Error('backend down');
      lists.push([add, remove]);
    },
    clock,
    log: quiet,
  });
  assert.equal((await sharer.set('bruce1', true)).state, 'ok');
  // Off, the runner removes it, but the list update fails: owed, and kept.
  listFails = true;
  answer = { logins: [], removed: [{ email: 'one@example.com', accountId: 'claude-5' }] };
  const off = await sharer.set('bruce1', false);
  assert.equal(off.state, 'failed');
  assert.match(off.message!, /shared logins list/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).runners.bruce1.unlisted, ['one@example.com']);
  // The next try finds nothing more to remove there, and still takes it off the list.
  listFails = false;
  answer = { logins: [], removed: [] };
  sharer.start();
  clock.advance(10 * 60_000);
  await sharer.idle();
  assert.deepEqual(lists.at(-1), [[], ['one@example.com']]);
  assert.deepEqual(sharer.list(), []);
  // A switches file that can't be written: the switch stays as it was.
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  await assert.rejects(sharer.set('bruce1', true), /Couldn't save the switch/);
  assert.deepEqual(sharer.list(), []);
  // Stopped (handing over): no switch is flipped here any more.
  sharer.stop();
  await assert.rejects(sharer.set('bruce1', true), /handing over/);
});

// Gemini's review, 26 Nov.
test("that runner's answer only lists emails this sent, whatever it says", async () => {
  const sent = new Set(['one@example.com']);
  const forged = { logins: [null, { email: 'work@example.com', state: 'added' }, { email: 'ONE@example.com', state: 'added', accountId: '../x' }, { email: 'one@example.com', state: 'bogus' }], removed: [{ email: 'gone@example.com', accountId: 'claude-9' }, 'x'] };
  assert.deepEqual(cleanAnswer(forged, sent), { logins: [{ email: 'one@example.com', state: 'added' }], removed: [{ email: 'gone@example.com', accountId: 'claude-9' }] });
  assert.deepEqual(cleanAnswer(null, sent), { logins: [], removed: [] });
  // So a switched-off share can't put a login on its list either.
  const mac = mainMac();
  const lists: [string[], string[]][] = [];
  const sharer = new LoginSharer({
    file: path.join(mac.root, 'login-share.json'),
    accounts: () => mac.accounts,
    pools: () => [],
    claudeMainJson: '',
    blocked: () => undefined,
    runner: () => ({ name: 'bruce', online: true }),
    sealKey: async () => keys().publicKey,
    share: async () => forged as never,
    setShared: async (_id, add, remove) => void lists.push([add, remove]),
    clock: new FakeClock(),
    log: quiet,
  });
  await sharer.set('bruce1', true);
  assert.deepEqual(lists[0]![0], ['one@example.com'], 'work@example.com was never sent, so never listed');
});

test('an offline runner gets nothing queued; the timer sends once the backend has heard from it', async () => {
  const mac = mainMac();
  let shares = 0;
  let fresh = new Set<string>();
  const clock = new FakeClock();
  const sharer = new LoginSharer({
    file: path.join(mac.root, 'login-share.json'),
    accounts: () => mac.accounts,
    pools: () => [],
    claudeMainJson: '',
    blocked: () => undefined,
    // The sidebar's list, frozen as it was when the app closed.
    runner: () => ({ name: 'bruce', online: false }),
    online: async () => fresh,
    sealKey: async () => keys().publicKey,
    share: async () => (shares++, { logins: [], removed: [] }),
    clock,
    log: quiet,
  });
  const row = await sharer.set('bruce1', true);
  assert.equal(row.state, 'waiting');
  assert.match(row.message!, /offline/);
  assert.equal(shares, 0);
  sharer.start();
  clock.advance(10 * 60_000);
  await sharer.idle();
  assert.equal(shares, 0, 'still not heard from');
  fresh = new Set(['bruce1']);
  clock.advance(10 * 60_000);
  await sharer.idle();
  assert.equal(shares, 1);
  sharer.stop();
});

test('twenty sealed logins with big profiles still fit one command', () => {
  const huge: Record<string, unknown> = { emailAddress: 'x@example.com', nested: { a: 1 }, long: 'y'.repeat(5000) };
  for (let i = 0; i < 200; i++) huge[`k${i}`] = `value-${i}`;
  const t = trimProfile(huge);
  assert.ok(JSON.stringify(t).length <= 1200);
  assert.equal(t.nested, undefined);
  assert.equal(t.long, undefined);
  const key = keys().publicKey;
  const logins = Array.from({ length: 20 }, (_, i) => ({ email: `user${i}@example.com`, token: fakeToken(), madeAt: '2026-11-01T00:00:00.000Z', oauthAccount: t }));
  const sealed = sealLogins('bruce1', key, logins);
  assert.ok(Buffer.byteLength(JSON.stringify({ method: 'logins.share', params: { logins: sealed } })) < 64 * 1024);
});

test('a copied folder is taken on even when another login there has the same email', async () => {
  const L = layoutFor();
  const copied = path.join(L.accountsDir, 'claude-3');
  fs.mkdirSync(copied, { recursive: true });
  const token = fakeToken();
  fs.writeFileSync(path.join(copied, 'threadbear-token.json'), JSON.stringify({ token }));
  const existing = [claude('claude-main', L.claudeMainDir, 'me@example.com'), claude('claude-3', copied, 'me@example.com')];
  const r = await applyShared(L, [{ email: 'me@example.com', token, oauthAccount: { emailAddress: 'me@example.com', organizationType: 'claude_max' } }], [], existing);
  assert.deepEqual(r.logins.map((l) => [l.state, l.accountId]), [['adopted', 'claude-3']]);
});

// Codex's and Gemini's second round, 26 Nov.
test("a removal that fails there keeps the switch going, and a lost answer still takes emails off the list", async () => {
  const mac = mainMac();
  const lists: [string[], string[]][] = [];
  let answer: unknown = { logins: [{ email: 'one@example.com', state: 'added', accountId: 'claude-5' }, { email: 'three@example.com', state: 'added', accountId: 'claude-6' }], removed: [] };
  const clock = new FakeClock();
  const sharer = new LoginSharer({
    file: path.join(mac.root, 'login-share.json'),
    accounts: () => mac.accounts,
    pools: () => [],
    claudeMainJson: '',
    blocked: () => undefined,
    runner: (id) => (id === 'bruce1' ? { name: 'bruce', online: true } : undefined),
    online: async () => new Set(['bruce1']),
    sealKey: async () => keys().publicKey,
    share: async () => answer as ShareAnswer,
    setShared: async (_id, add, remove) => void lists.push([add, remove]),
    clock,
    log: quiet,
  });
  await sharer.set('bruce1', true);
  // Off, but one folder there couldn't be moved: it says so, and it's tried again.
  answer = { logins: [{ email: 'one@example.com', state: 'failed', accountId: 'claude-5', message: "Couldn't remove claude-5: EBUSY" }], removed: [{ email: 'three@example.com', accountId: 'claude-6' }] };
  const off = await sharer.set('bruce1', false);
  assert.equal(off.state, 'failed');
  assert.match(off.message!, /EBUSY/);
  assert.deepEqual(lists.at(-1), [[], ['three@example.com']], 'still there, so still listed');
  // The retry removes it, but its answer is lost: it comes off the list anyway.
  answer = { logins: [], removed: [] };
  sharer.start();
  clock.advance(10 * 60_000);
  await sharer.idle();
  assert.deepEqual(lists.at(-1), [[], ['one@example.com']]);
  assert.deepEqual(sharer.list(), []);
  sharer.stop();
});

test("a removal cut short leaves no token behind, and a runner the backend forgot can still be switched off", async () => {
  const L = layoutFor();
  const aside = path.join(L.accountsDir, '.removed', 'claude-4-2026');
  fs.mkdirSync(aside, { recursive: true });
  fs.writeFileSync(path.join(aside, 'threadbear-token.json'), JSON.stringify({ token: fakeToken() }));
  fs.writeFileSync(path.join(aside, '.threadbear-token.json.123.abcd.tmp'), 'x');
  fs.writeFileSync(path.join(aside, 'history.jsonl'), 'kept');
  fs.writeFileSync(path.join(aside, MARKER_FILE), JSON.stringify({ email: 'a@example.com' }));
  // One put there by hand, with no marker: left alone.
  const manual = path.join(L.accountsDir, '.removed', 'manual-backup');
  fs.mkdirSync(manual);
  const kept = fakeToken();
  fs.writeFileSync(path.join(manual, 'threadbear-token.json'), JSON.stringify({ token: kept }));
  await applyShared(L, [], [], []);
  assert.deepEqual(fs.readdirSync(aside).sort(), ['history.jsonl', MARKER_FILE].sort());
  assert.ok(tokenIn(manual) === kept);
  const mac = mainMac();
  const file = path.join(mac.root, 'login-share.json');
  fs.writeFileSync(file, JSON.stringify({ runners: { gone1: { on: true, state: 'ok' } } }));
  fs.writeFileSync(file, JSON.stringify({ runners: { gone1: { on: true, state: 'ok' }, later1: { on: true, state: 'ok' } } }));
  const sharer = new LoginSharer({ file, accounts: () => [], pools: () => [], claudeMainJson: '', blocked: () => undefined, runner: () => undefined, known: async (id) => id === 'later1', sealKey: async () => assert.fail(), share: async () => assert.fail(), clock: new FakeClock(), log: quiet });
  assert.equal(sharer.list().length, 2);
  assert.equal((await sharer.set('gone1', false)).state, 'off');
  // Not in the sidebar's list yet (just after a start), but the backend has it: kept, to send when it can.
  const later = await sharer.set('later1', false);
  assert.equal(later.state, 'waiting');
  assert.deepEqual(sharer.list().map((r) => r.runnerId), ['later1']);
});

test('a profile in another script is measured in bytes, keeps its email, and never holds up the others', () => {
  const cjk = '漢'.repeat(200);
  const t = trimProfile({ emailAddress: 'x@example.com', a: cjk, b: cjk, c: cjk, d: cjk, e: cjk });
  assert.ok(Buffer.byteLength(JSON.stringify(t)) <= 1200);
  assert.equal(t.emailAddress, 'x@example.com');
  const key = keys().publicKey;
  const sealed = sealLogins('bruce1', key, [{ email: 'x@example.com', token: fakeToken(), oauthAccount: { emailAddress: 'x@example.com', big: '漢'.repeat(5000) } }]);
  assert.ok(sealed[0]!.box.length <= 2800);
});
