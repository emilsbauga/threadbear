// Releases signed by a weekly key the release key certified
// (release-keys.ts, "Releases signed by a weekly key"; release-delegate.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FakeClock } from '../../src/clock.ts';
import { applyKeyChanges, certVerifyArgs, keyFilesHash, KEYS_EXTENSION, keyStatePath, readRevoked, readWeeklyRevoked, revokedPath, signatureCert, signerKey, weeklyRevokedPath, withAuthorities } from '../../src/release-keys.ts';
import { currentCert, delegatePaths, readDelegateState, renewDelegate, usableCert } from '../../src/release-delegate.ts';
import { gitAsync, signersPath, type GitOptions } from '../../src/upstream.ts';
import { GIT_ENV, commit, git, key, pubOf, release, upstreamFor, world } from '../helpers/upstream-harness.ts';

type World = ReturnType<typeof world>;

// The key files at Mike's HEAD, as a release there has them.
function keyFiles(w: World): { signers: string; revoked: string } {
  const show = (f: string) => spawnSync('git', ['-C', w.mike, 'show', `HEAD:${f}`], { encoding: 'utf8' });
  const r = show('scripts/release-keys-revoked');
  return { signers: show('scripts/release-signers').stdout, revoked: r.status === 0 ? r.stdout : '' };
}

// A weekly key certified by `ca` for Mike's principal, valid as `-V` says,
// vouching for the key files at Mike's HEAD (or `files`).
function weekly(w: World, name: string, validity: string, ca = w.mikeKey.priv, files = keyFiles(w)): { priv: string; cert: string; pub: string } {
  const priv = path.join(w.root, name);
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', priv]).status, 0);
  const ext = `extension:${KEYS_EXTENSION}=${keyFilesHash(files.signers, files.revoked)}`;
  const r = spawnSync('ssh-keygen', ['-q', '-s', ca, '-I', name, '-n', 'mike@example.com', '-V', validity, '-O', 'clear', '-O', ext, `${priv}.pub`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return { priv, cert: `${priv}-cert.pub`, pub: fs.readFileSync(`${priv}.pub`, 'utf8').split(' ').slice(0, 2).join(' ') };
}

// Noon UTC (today's, or yesterday's if it's still ahead): not ahead of
// forks' clocks, and a day that's the same here and in UTC.
function noonUtc(): number {
  const d = new Date();
  const noon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  return noon <= Date.now() ? noon : noon - 24 * 60 * 60_000;
}

// A fork whose clock is inside the test certificates' week (29 Oct to 6
// Nov 2026): it takes a weekly key's release only while that's good now.
const forkAt = (w: World, iso = '2026-11-05T00:00:00Z') => upstreamFor(w.theirs, w.home, new FakeClock(Date.parse(iso)));

const armorOf = (tag: string) => tag.slice(tag.indexOf('-----BEGIN SSH SIGNATURE-----')) + '\n';

// A release tag signed with a weekly key's certificate, dated `date`.
function certTag(repo: string, tag: string, cert: string, date: string, rev = 'HEAD'): void {
  const r = spawnSync('git', ['-C', repo, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${cert}`, 'tag', '-s', '-m', `Threadbear ${tag}`, tag, rev], { encoding: 'utf8', env: { ...GIT_ENV, GIT_COMMITTER_DATE: date, SSH_AUTH_SOCK: '' } });
  assert.equal(r.status, 0, r.stderr);
}

function commitFile(w: World, file: string, text: string, subject: string): string {
  fs.writeFileSync(path.join(w.mike, file), text);
  git(w.mike, 'add', file);
  git(w.mike, 'commit', '-q', '-m', subject);
  return git(w.mike, 'rev-parse', 'HEAD');
}

test('a fork takes a release signed by a weekly key its pinned key certified', async () => {
  const w = world();
  const k = weekly(w, 'week', '20261029Z:20261106Z');
  const tip = commit(w.mike, 'b.txt', 'Work');
  certTag(w.mike, 'release/2026-10-30', k.cert, '2026-10-30T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await forkAt(w).check();
  assert.equal(s.release?.tag, 'release/2026-10-30', s.reason ?? '');
  assert.equal(s.release?.commit, tip);
  // The release counts as the pinned key's, for the key rules.
  const sig = armorOf(git(w.mike, 'cat-file', 'tag', 'release/2026-10-30'));
  assert.equal(signerKey(sig), pubOf(w.mikeKey));
  assert.equal(signatureCert(sig)?.key, k.pub);
});

test("not when the tag's date is outside the certificate, or not the day its name says", async () => {
  const w = world();
  const k = weekly(w, 'week', '20261029Z:20261106Z');
  commit(w.mike, 'b.txt', 'After it ran out');
  certTag(w.mike, 'release/2026-11-20', k.cert, '2026-11-20T10:00:00Z');
  commit(w.mike, 'c.txt', 'Backdated, under a newer name');
  certTag(w.mike, 'release/2026-11-21', k.cert, '2026-11-01T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await forkAt(w).check();
  assert.equal(s.release?.tag, 'release/2026-10-01', `${s.state} ${s.reason ?? ''}`);
});

// Gemini's and Codex's reviews, 25 Nov 2026.
test('certVerifyArgs: only a real UTC day, never ahead of now, never tomorrow', () => {
  const now = Date.parse('2026-12-30T12:00:00Z');
  assert.equal(certVerifyArgs('release/2027-00-05', '2026-12-05T12:00:00Z', now), undefined, 'month 00 is not December');
  assert.equal(certVerifyArgs('release/2026-12-00', '2026-11-29T10:30:00Z', now), undefined, 'day 00 is not 30 Nov');
  assert.equal(certVerifyArgs('release/2026-02-30', '2026-03-02T00:00:00Z', now), undefined);
  assert.ok(certVerifyArgs('release/2026-12-29', '2026-12-29T00:00:00Z', now));
  assert.ok(certVerifyArgs('release/2026-12-29', '2026-12-29T23:59:59Z', now));
  assert.equal(certVerifyArgs('release/2026-12-29', '2026-12-28T23:00:00Z', now), undefined, "UTC's day only");
  assert.equal(certVerifyArgs('release/2026-12-29', '2026-12-30T00:00:01Z', now), undefined);
  assert.equal(certVerifyArgs('release/2027-01-01', '2027-01-01T00:00:00Z', now), undefined, 'dated ahead');
  const lastHour = Date.parse('2026-12-30T23:30:00Z');
  assert.equal(certVerifyArgs('release/2026-12-31', '2026-12-31T00:00:00Z', lastHour), undefined, "tomorrow's name in today's last hour");
});

test("not a certificate from a key that isn't pinned, nor a weekly key that's been revoked", async () => {
  const w = world();
  const stranger = key(w.root, 'stranger');
  const theirs = weekly(w, 'strangers-week', '20261029Z:20261106Z', stranger.priv);
  commit(w.mike, 'b.txt', 'Certified by a stranger');
  certTag(w.mike, 'release/2026-10-30', theirs.cert, '2026-10-30T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  assert.equal((await forkAt(w).check()).release?.tag, 'release/2026-10-01');

  const leaked = weekly(w, 'leaked', '20261029Z:20261106Z');
  commit(w.mike, 'c.txt', 'Signed by a leaked weekly key');
  certTag(w.mike, 'release/2026-10-31', leaked.cert, '2026-10-31T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = forkAt(w);
  assert.equal((await up.check()).release?.tag, 'release/2026-10-31', 'taken until it is revoked');
  // Revoked, on the same runner: not from an answer kept from before.
  fs.writeFileSync(weeklyRevokedPath(w.home), `${leaked.pub}\n`);
  assert.equal((await up.check()).release?.tag, 'release/2026-10-01');
});

test("not a weekly key's release whose key files aren't the ones its certificate vouches for", async () => {
  const w = world();
  const k = weekly(w, 'week', '20261029Z:20261106Z');
  const attacker = key(w.root, 'attacker');
  commitFile(w, 'scripts/release-signers', fs.readFileSync(w.mikeKey.signers, 'utf8') + fs.readFileSync(attacker.signers, 'utf8'), 'Announce a key of their own');
  certTag(w.mike, 'release/2026-10-30', k.cert, '2026-10-30T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  assert.equal((await forkAt(w).check()).release?.tag, 'release/2026-10-01');
  const pending = fs.existsSync(keyStatePath(w.home)) ? (JSON.parse(fs.readFileSync(keyStatePath(w.home), 'utf8')).pending as unknown[]) : [];
  assert.equal(pending.length, 0, 'its key not announced');
});

test("not a certificate for a kind of key the check can't read the dates of", async () => {
  const w = world();
  const priv = path.join(w.root, 'ecdsa-week');
  assert.equal(spawnSync('ssh-keygen', ['-q', '-t', 'ecdsa', '-N', '', '-f', priv]).status, 0);
  assert.equal(spawnSync('ssh-keygen', ['-q', '-s', w.mikeKey.priv, '-I', 'e', '-n', 'mike@example.com', '-V', '-1d:+8d', `${priv}.pub`]).status, 0);
  commit(w.mike, 'b.txt', 'An ecdsa weekly key');
  certTag(w.mike, 'release/2026-10-30', `${priv}-cert.pub`, '2026-10-30T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  assert.equal((await forkAt(w).check()).release?.tag, 'release/2026-10-01');
});

test('a fork away the day a key change went out takes it from the next weekly-signed release', async () => {
  const w = world();
  const next = key(w.root, 'next');
  release(w, 'release/2026-10-29', w.mikeKey.priv, { 'scripts/release-signers': fs.readFileSync(w.mikeKey.signers, 'utf8') + fs.readFileSync(next.signers, 'utf8') });
  // Renewed with a touch after the change, so it vouches for the new files.
  const k = weekly(w, 'week', '20261029Z:20261106Z');
  commit(w.mike, 'c.txt', 'Weekly');
  certTag(w.mike, 'release/2026-10-30', k.cert, '2026-10-30T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  assert.equal((await forkAt(w).check()).release?.tag, 'release/2026-10-30');
  const pending = JSON.parse(fs.readFileSync(keyStatePath(w.home), 'utf8')).pending as { key: string }[];
  assert.deepEqual(pending.map((p) => p.key), [pubOf(next)]);
});

// Codex's review: a leaked weekly key signing an older commit, under a
// newer name, mustn't hide the release that revokes it.
test('a revocation in an older release still counts when a revoked weekly key signed a newer one', async () => {
  const w = world();
  const leaked = weekly(w, 'leaked', '20261029Z:20261106Z');
  const b = commit(w.mike, 'b.txt', 'Something bad, never released');
  commitFile(w, 'scripts/release-keys-revoked', `${leaked.pub}\n`, 'Revoke the leaked weekly key');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-s', '-m', 'Threadbear release/2026-10-29', 'release/2026-10-29');
  certTag(w.mike, 'release/2026-10-30', leaked.cert, '2026-10-30T10:00:00Z', b);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await forkAt(w).check();
  assert.equal(s.release?.tag, 'release/2026-10-29', s.reason ?? '');
  assert.deepEqual(readWeeklyRevoked(w.home), [leaked.pub]);
});

test('withAuthorities: each pinned key also counts as an authority, for git only', () => {
  const line = 'threadbear-releases namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample';
  assert.equal(withAuthorities(`${line}\n`), `${line}\nthreadbear-releases cert-authority,namespaces="git" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample\n`);
  assert.equal(withAuthorities('# a comment\n'), '# a comment\n');
});

test("a release revoking a key nobody's pinned puts it with the weekly keys only, so it can still be pinned", () => {
  const w = world();
  const signers = path.join(w.root, 'pinned');
  fs.copyFileSync(w.mikeKey.signers, signers);
  const mike = pubOf(w.mikeKey);
  const future = key(w.root, 'future');
  const r = applyKeyChanges({ home: w.home, signers, signer: mike, announced: [], revoke: [pubOf(future)], tag: 't', now: 0 });
  assert.deepEqual(r.revoked, [pubOf(future)]);
  assert.deepEqual(readRevoked(w.home), []);
  assert.deepEqual(readWeeklyRevoked(w.home), [pubOf(future)]);
  applyKeyChanges({ home: w.home, signers, signer: mike, announced: [pubOf(future)], revoke: [], tag: 't2', now: 0 });
  assert.equal(JSON.parse(fs.readFileSync(keyStatePath(w.home), 'utf8')).pending.length, 1, 'it can still be announced');
  // Only ed25519 keys, which weekly keys are.
  applyKeyChanges({ home: w.home, signers, signer: mike, announced: [], revoke: ['sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNh'], tag: 't3', now: 0 });
  assert.deepEqual(readWeeklyRevoked(w.home), [pubOf(future)]);
  // An older release's, read for revocations alone, announces nothing.
  const other = key(w.root, 'other');
  applyKeyChanges({ home: w.home, signers, signer: mike, announced: [pubOf(other)], revoke: [], tag: 't4', now: 0, onlyRevoke: true });
  assert.equal(JSON.parse(fs.readFileSync(keyStatePath(w.home), 'utf8')).pending.length, 1);
});

// Mike's side: the release before has the check that takes the weekly key,
// and his weekly key is in place, vouching for main's key files.
function readyToDelegate(w: World, validity = '-3d:+8d') {
  release(w, 'release/2026-10-02', w.mikeKey.priv, { 'runner/src/release-keys.ts': `// ${KEYS_EXTENSION}\n` });
  const k = weekly(w, 'week', validity);
  const p = delegatePaths(w.home);
  fs.mkdirSync(path.dirname(p.key), { recursive: true });
  fs.copyFileSync(k.priv, p.key);
  fs.copyFileSync(`${k.priv}.pub`, `${p.key}.pub`);
  fs.copyFileSync(k.cert, p.cert);
  return k;
}

test("Mike's runner signs with the weekly key, and a fork takes it", async () => {
  const w = world();
  readyToDelegate(w);
  commit(w.mike, 'b.txt', 'Newer work');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const clock = new FakeClock(noonUtc());
  const signs: string[][] = [];
  const up = upstreamFor(w.mike, w.home, clock, {
    publish: { publish: true, signingKey: w.mikeKey.priv, delegate: true },
    runningMainSettled: () => true,
    git: (cwd: string, args: string[], opts: GitOptions = {}) => {
      if (args.includes('-s') && args.includes('tag')) signs.push(args);
      return gitAsync(cwd, args, opts);
    },
  });
  const tag = await up.publishOnce({ now: true });
  assert.ok(tag, up.status().held?.why ?? 'no tag');
  assert.ok(signs[0]!.includes(`user.signingkey=${delegatePaths(w.home).cert}`));
  assert.ok(signatureCert(armorOf(git(w.mike, 'cat-file', 'tag', tag))));
  assert.equal((await upstreamFor(w.theirs, w.home, clock).check()).release?.tag, tag);
});

test("the release key signs instead until forks have the check, when the weekly key's run out, is revoked, isn't its key's, or doesn't vouch for the key files", { timeout: 240_000 }, async () => {
  for (const how of ['no check yet', 'ran out', 'revoked', 'mismatched', 'key change'] as const) {
    const w = world();
    if (how === 'no check yet') {
      const k = weekly(w, 'week', '-3d:+8d');
      fs.mkdirSync(path.dirname(delegatePaths(w.home).key), { recursive: true });
      fs.copyFileSync(k.priv, delegatePaths(w.home).key);
      fs.copyFileSync(`${k.priv}.pub`, `${delegatePaths(w.home).key}.pub`);
      fs.copyFileSync(k.cert, delegatePaths(w.home).cert);
    } else {
      const k = readyToDelegate(w, how === 'ran out' ? '-10d:-1d' : '-3d:+8d');
      if (how === 'revoked') commitFile(w, 'scripts/release-keys-revoked', `${k.pub}\n`, 'Revoke the weekly key');
      else if (how === 'mismatched') {
        const other = key(w.root, 'other');
        fs.copyFileSync(other.priv, delegatePaths(w.home).key);
      } else if (how === 'key change') {
        const next = key(w.root, 'next');
        commitFile(w, 'scripts/release-signers', fs.readFileSync(w.mikeKey.signers, 'utf8') + fs.readFileSync(next.signers, 'utf8'), 'Announce a new key');
      }
    }
    commit(w.mike, 'b.txt', 'Newer work');
    git(w.mike, 'push', '-q', 'origin', 'main');
    const up = upstreamFor(w.mike, w.home, new FakeClock(noonUtc()), { publish: { publish: true, signingKey: w.mikeKey.priv, delegate: true }, runningMainSettled: () => true });
    const tag = await up.publishOnce({ now: true });
    assert.ok(tag, `${how}: ${up.status().held?.why ?? ''}`);
    assert.equal(signatureCert(armorOf(git(w.mike, 'cat-file', 'tag', tag))), undefined, how);
  }
});

test("Mike's runner waits for UTC's day rather than ask for Touch ID, unless he asks", async () => {
  const w = world();
  readyToDelegate(w);
  // A moment whose local day isn't UTC's, if this machine has one: 23:30
  // UTC east of Greenwich, 00:30 UTC west, a day or two back.
  const off = new Date().getTimezoneOffset();
  if (off === 0) return;
  const d = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), off < 0 ? 23 : 0, 30);
  // Committed a couple of hours before, so main has settled by then.
  fs.writeFileSync(path.join(w.mike, 'b.txt'), 'Newer work');
  git(w.mike, 'add', 'b.txt');
  const when = `${Math.floor((at - 2 * 60 * 60_000) / 1000)} +0000`;
  assert.equal(spawnSync('git', ['-C', w.mike, 'commit', '-q', '-m', 'Newer work'], { env: { ...GIT_ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } }).status, 0);
  git(w.mike, 'push', '-q', 'origin', 'main');
  const up = upstreamFor(w.mike, w.home, new FakeClock(at), { publish: { publish: true, signingKey: w.mikeKey.priv, delegate: true }, runningMainSettled: () => true });
  assert.equal(await up.publishOnce(), undefined);
  assert.match(up.status().held?.why ?? '', /UTC's day/);
  const tag = await up.publishOnce({ now: true });
  assert.ok(tag, up.status().held?.why ?? '');
  assert.equal(signatureCert(armorOf(git(w.mike, 'cat-file', 'tag', tag))), undefined, 'the release key signed it');
});

// Codex's and Gemini's reviews: tags that will never verify mustn't hold
// every check's places, or a release revoking a key stays out of sight.
test("a flood of tags that never verify doesn't hide a revocation, not even for a check", { timeout: 240_000 }, async () => {
  const w = world();
  const up = forkAt(w);
  assert.equal((await up.check()).release?.tag, 'release/2026-10-01', 'what the fork had');
  const leaked = weekly(w, 'leaked', '20261029Z:20261106Z');
  const b = commit(w.mike, 'b.txt', 'Something bad, never released');
  commitFile(w, 'scripts/release-keys-revoked', `${leaked.pub}\n`, 'Revoke the leaked weekly key');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-s', '-m', 'Threadbear release/2026-10-29', 'release/2026-10-29');
  certTag(w.mike, 'release/2026-10-30', leaked.cert, '2026-10-30T10:00:00Z', b);
  const stranger = key(w.root, 'stranger');
  const junk = weekly(w, 'junk', '20261029Z:20261231Z', stranger.priv);
  // Nineteen, so the first check reads them and the revoked key's release,
  // and not the release revoking it (Codex's review).
  for (let day = 1; day <= 19; day++) certTag(w.mike, `release/2026-11-${String(day).padStart(2, '0')}`, junk.cert, `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`, b);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  let tag: string | undefined;
  for (let i = 0; i < 4 && tag !== 'release/2026-10-29'; i++) {
    tag = (await up.check()).release?.tag;
    assert.notEqual(tag, 'release/2026-10-30', `check ${i + 1} offered the revoked key's release`);
  }
  assert.equal(tag, 'release/2026-10-29');
  assert.deepEqual(readWeeklyRevoked(w.home), [leaked.pub]);
});

test('release names are real months and days', async () => {
  const { RELEASE_NAME } = await import('../../src/upstream.ts');
  for (const n of ['2026-11-25', '2026-12-31', '2027-01-01']) assert.ok(RELEASE_NAME.test(n), n);
  for (const n of ['2026-11-99', '2026-00-05', '2026-13-01', '2026-11-00', '2026-11-32']) assert.equal(RELEASE_NAME.test(n), false, n);
});

test('renewDelegate makes a key the release key certifies for these key files, checked before it goes in place', async () => {
  const w = world();
  const { signers, revoked } = keyFiles(w);
  const now = Date.now();
  const c = await renewDelegate({ home: w.home, signingKey: w.mikeKey.priv, signers, revoked, now, timeoutMs: 30_000 });
  assert.equal(c.ca, pubOf(w.mikeKey));
  assert.deepEqual(c.principals, ['mike@example.com']);
  assert.equal(c.keys, keyFilesHash(signers, revoked));
  assert.ok(c.validBefore - now > 7.9 * 24 * 60 * 60_000 && c.validBefore - now <= 8 * 24 * 60 * 60_000 + 60_000);
  assert.deepEqual(currentCert(w.home), c);
  assert.ok(usableCert(w.home, w.mikeKey.priv, signers, revoked));
  assert.equal(usableCert(w.home, w.mikeKey.priv, signers, `${c.key}\n`), undefined, 'revoked, and other key files');
  // Unix permissions (Windows has none to read this way).
  if (process.platform !== 'win32') assert.equal(fs.statSync(delegatePaths(w.home).key).mode & 0o077, 0, 'the key is private');

  // A key that isn't in release-signers isn't certified.
  const stranger = key(w.root, 'stranger');
  await assert.rejects(renewDelegate({ home: w.home, signingKey: stranger.priv, signers, revoked, now, timeoutMs: 30_000 }), /not in release-signers/);
  assert.deepEqual(currentCert(w.home), c, 'the one in place stays');

  // Not when the private key beside it is another's.
  fs.copyFileSync(stranger.priv, delegatePaths(w.home).key);
  assert.equal(usableCert(w.home, w.mikeKey.priv, signers, revoked), undefined);
});

test('a weekly key near its end that Touch ID never renewed starts one starred reminder', async () => {
  const w = world();
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  // A Secure Enclave key's handle, which can't really sign here.
  const handle = path.join(w.root, 'id_ecdsa_sk_rk');
  fs.writeFileSync(handle, 'handle\n');
  fs.writeFileSync(`${handle}.pub`, 'sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNh threadbear-release\n');
  const started: { title: string; text: string }[] = [];
  let open = true;
  let atMacAsked = 0;
  const up = upstreamFor(w.mike, w.home, new FakeClock(committed), {
    publish: { publish: true, signingKey: handle, delegate: true },
    runningMainSettled: () => false,
    atMac: async () => (atMacAsked++, false),
    remind: (r: { title: string; text: string }) => (started.push(r), `t${started.length}`),
    isOpen: () => open,
  });
  await up.publishOnce();
  assert.equal(started.length, 1);
  assert.match(started[0]!.title, /Renew the release signing key/);
  assert.match(started[0]!.text, /tb updates publish/);
  assert.equal(readDelegateState(w.home).remindThread, 't1');
  assert.equal(atMacAsked, 1, 'renewing waits for Mike at the Mac');
  await up.publishOnce();
  assert.equal(started.length, 1, 'not again while that thread is open');
  open = false;
  await up.publishOnce();
  assert.equal(started.length, 2, 'again once he archived it unrenewed');
});

test('revokedPath is where a fork keeps revoked keys', () => {
  assert.equal(weeklyRevokedPath('/h'), `${revokedPath('/h')}-weekly`);
});

// Codex's reviews: a weekly key's release is taken only in its week, so
// however the tags are arranged, a leaked one is good for that long.
test("a weekly key's release isn't taken once its week is over, fresh copy or not", { timeout: 240_000 }, async () => {
  const w = world();
  const leaked = weekly(w, 'leaked', '20261102Z:20261110Z');
  commit(w.mike, 'b.txt', 'Something bad');
  certTag(w.mike, 'release/2026-11-05', leaked.cert, '2026-11-05T10:00:00Z');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  assert.equal((await forkAt(w, '2026-11-20T00:00:00Z').check()).release?.tag, 'release/2026-10-01');
  assert.equal((await forkAt(w, '2026-11-06T00:00:00Z').check()).release?.tag, 'release/2026-11-05', 'in its week');
  assert.equal((await forkAt(w, '2026-11-20T00:00:00Z').check()).release?.tag, 'release/2026-11-05', 'and kept after');
});

// Twenty-five signed tags: git on Windows CI takes over a minute for them.
test('a copy away for weeks catches up', { timeout: 240_000 }, async () => {
  const w = world();
  const up = upstreamFor(w.theirs, w.home);
  assert.equal((await up.check()).release?.tag, 'release/2026-10-01');
  for (let day = 2; day <= 26; day++) {
    commit(w.mike, `d${day}.txt`, `Day ${day}`);
    git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-s', '-m', 'Threadbear', `release/2026-10-${String(day).padStart(2, '0')}`);
  }
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  assert.equal((await up.check()).release?.tag, 'release/2026-10-26');
});

// Gemini's ninth look: an older release read for its revocations mustn't
// let in a key that's waited its week before the newest revokes it.
test("an older release read for revocations doesn't let a waiting key in", () => {
  const w = world();
  const signers = path.join(w.root, 'pinned');
  fs.copyFileSync(w.mikeKey.signers, signers);
  const mike = pubOf(w.mikeKey);
  const evil = key(w.root, 'evil');
  applyKeyChanges({ home: w.home, signers, signer: mike, announced: [pubOf(evil)], revoke: [], tag: 'release/2026-10-01', now: 0 });
  const later = 8 * 24 * 60 * 60_000;
  const r = applyKeyChanges({ home: w.home, signers, signer: mike, announced: [pubOf(evil)], revoke: [], tag: 'release/2026-10-01', now: later, onlyRevoke: true });
  assert.deepEqual(r.added, []);
  assert.equal(fs.readFileSync(signers, 'utf8').includes(pubOf(evil)), false);
  // The newest, revoking it, then has its say.
  applyKeyChanges({ home: w.home, signers, signer: mike, announced: [], revoke: [pubOf(evil)], tag: 'release/2026-10-02', now: later });
  assert.equal(fs.readFileSync(signers, 'utf8').includes(pubOf(evil)), false);
});

// Twenty-two signed tags: git on Windows CI takes over a minute for them.
test("a run of weekly keys' releases whose week is over doesn't keep a fork from older ones", { timeout: 240_000 }, async () => {
  const w = world();
  const real = release(w, 'release/2026-10-05', w.mikeKey.priv);
  const k = weekly(w, 'week', '20261006Z:20261014Z');
  for (let day = 6; day <= 13; day++) {
    commit(w.mike, `d${day}.txt`, `Day ${day}`);
    certTag(w.mike, `release/2026-10-${String(day).padStart(2, '0')}`, k.cert, `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`);
  }
  const k2 = weekly(w, 'week2', '20261014Z:20261022Z');
  for (let day = 14; day <= 21; day++) {
    commit(w.mike, `d${day}.txt`, `Day ${day}`);
    certTag(w.mike, `release/2026-10-${day}`, k2.cert, `2026-10-${day}T10:00:00Z`);
  }
  const k3 = weekly(w, 'week3', '20261022Z:20261030Z');
  for (let day = 22; day <= 27; day++) {
    commit(w.mike, `d${day}.txt`, `Day ${day}`);
    certTag(w.mike, `release/2026-10-${day}`, k3.cert, `2026-10-${day}T10:00:00Z`);
  }
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = forkAt(w, '2026-11-20T00:00:00Z');
  let s;
  for (let i = 0; i < 3; i++) s = await up.check();
  assert.equal(s?.release?.tag, 'release/2026-10-05');
  assert.ok(real);
});

test("Mike's runner puts a quiet main out again before its weekly key's release lapses", async () => {
  const w = world();
  readyToDelegate(w);
  commit(w.mike, 'b.txt', 'Newer work');
  git(w.mike, 'push', '-q', 'origin', 'main');
  // Tagged with a weekly key whose week ends within two days.
  const short = weekly(w, 'short', '-3d:+1d');
  const today = noonUtc();
  const name = `release/${new Date(today - 24 * 60 * 60_000).toISOString().slice(0, 10)}`;
  certTag(w.mike, name, short.cert, new Date(today - 24 * 60 * 60_000).toISOString());
  git(w.mike, 'push', '-q', 'origin', name);
  const up = upstreamFor(w.mike, w.home, new FakeClock(today), { publish: { publish: true, signingKey: w.mikeKey.priv, delegate: true }, runningMainSettled: () => true });
  const tag = await up.publishOnce({ now: true });
  assert.equal(tag, `release/${new Date(today).toISOString().slice(0, 10)}`, up.status().held?.why ?? '');
  assert.equal(git(w.mike, 'rev-parse', `${tag}^{commit}`), git(w.mike, 'rev-parse', `${name}^{commit}`), 'the same commit');
  assert.ok(signatureCert(armorOf(git(w.mike, 'cat-file', 'tag', tag!))), 'by the weekly key in place, with its week ahead');
});

// Gemini's tenth look: weekly releases whose week is over still have their
// revocations read, even when none of them can be taken.
test("a revocation in weekly releases whose week is over still counts", { timeout: 240_000 }, async () => {
  const w = world();
  const next = key(w.root, 'next');
  fs.appendFileSync(signersPath(w.home), fs.readFileSync(next.signers, 'utf8'));
  commitFile(w, 'scripts/release-signers', fs.readFileSync(w.mikeKey.signers, 'utf8') + fs.readFileSync(next.signers, 'utf8'), 'A second release key');
  commitFile(w, 'scripts/release-keys-revoked', `${pubOf(w.mikeKey)}\n`, 'Revoke the first');
  const k = weekly(w, 'week', '20261102Z:20261110Z', next.priv);
  for (let day = 3; day <= 6; day++) {
    commit(w.mike, `d${day}.txt`, `Day ${day}`);
    certTag(w.mike, `release/2026-11-0${day}`, k.cert, `2026-11-0${day}T10:00:00Z`);
  }
  // The revoked key, leaked, signs a newer release itself.
  commit(w.mike, 'bad.txt', 'Something bad');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-s', '-m', 'Threadbear', 'release/2026-11-20');
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = forkAt(w, '2026-11-20T12:00:00Z');
  for (let i = 0; i < 3; i++) assert.notEqual((await up.check()).release?.tag, 'release/2026-11-20', `check ${i + 1}`);
  assert.ok(readRevoked(w.home).includes(pubOf(w.mikeKey)));
});

// Codex's twelfth look: another runner holding the key lock leaves this
// check's revocations unread, so it keeps nothing new and fails.
test('a check that finds the release keys locked keeps nothing new and looks again', async () => {
  const w = world();
  const up = forkAt(w);
  assert.equal((await up.check()).release?.tag, 'release/2026-10-01');
  release(w, 'release/2026-10-30', w.mikeKey.priv, { 'scripts/release-keys-revoked': 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVlZWVl\n' });
  const lock = path.join(w.home, 'upstream-keys.lock');
  fs.writeFileSync(lock, `${process.pid} someone-else`);
  const s = await up.check();
  assert.equal(s.state, 'failed', s.reason ?? '');
  assert.equal(git(w.theirs, 'for-each-ref', 'refs/threadbear/upstream/2026-10-30'), '', 'not kept');
  fs.rmSync(lock);
  assert.equal((await up.check()).release?.tag, 'release/2026-10-30');
});
